// cr-listen — the Mac's ear for Sous.
//
// Electron's renderer has no working SpeechRecognition (Chromium's needs a
// Google key), and macOS system dictation only types into text fields, of
// which the zoomed xterm is not one. So the desktop listens through Apple's
// on-device recognizer instead: no key, no cloud, zh-CN and en-US resident on
// the machine, partial results as they form.
//
// TWO EARS, ONE MICROPHONE. Measured 2026-09-06: the zh-CN recognizer turns
// "Conductor" into 双球 and "cookrew dev" into 肌肉求生, hints or no hints,
// while en-US hears both exactly. `--locale` may be given more than once —
// every recognizer gets the same audio, the FIRST is the primary, the others
// come back as `alternates` — BUT two on-device recognizers in ONE process
// are unreliable (one dies at once with 1110, which one varies), so main
// runs one process per locale instead (src/main/listen.ts) and merges. The
// multi-locale path stays for experiments; do not ship on it.
//
// Objective-C rather than Swift on purpose: it builds with `clang` from any
// Command Line Tools install, whereas swiftc on this machine is broken by a
// stale SwiftBridging modulemap (a root-owned fix). A postinstall step must not
// depend on the owner having repaired their toolchain.
//
// Contract (main spawns it on ⌘-down, SIGINTs it on ⌘-up):
//   stdout, one JSON object per line
//     {"ready":true,"locales":["zh-CN","en-US"],"onDevice":true}
//     {"partial":"切换工作台到"}                       the primary, as it forms
//     {"final":"切换工作台到 cookrew dev",
//      "alternates":{"en-US":"switch to cookrew dev"}} once, then exit 0
//     {"error":"<reason>"}                              then exit 1
//   flags
//     --locale zh-CN        recognizer locale; repeat for more (first = primary)
//     --hint "Conductor"    a name to expect; repeat (contextualStrings)
//     --max-seconds 30      hard stop, for a held key that never lifts
//     --allow-server        permit Apple's server when on-device is unavailable
//                           (off by default: the words must stay on the Mac)
//     --file f.aiff         recognize a recording instead of the mic (primary)
//     --stream-file f.aiff  push a recording through the live buffer path
//   env
//     CR_LISTEN_METER=1     level + task diagnostics on stderr
//     CR_LISTEN_DUMP=x.caf  write what the tap delivers
//
// Build: clang -fobjc-arc -O2 -o cr-listen cr-listen.m \
//          -framework Foundation -framework Speech -framework AVFoundation

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Speech/Speech.h>
#import <signal.h>

static void emit(NSDictionary *object) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  if (!data) return;
  NSMutableData *line = [data mutableCopy];
  [line appendBytes:"\n" length:1];
  [[NSFileHandle fileHandleWithStandardOutput] writeData:line];
}

static void __attribute__((noreturn)) fail(NSString *reason) {
  emit(@{@"error" : reason});
  exit(1);
}

/// Long enough for a person to read the permission dialog and click; a
/// dialog dismissed with no answer, or an OS that never calls back (stale
/// TCC state happens), must still end in a sentence and an exit.
static const int64_t AUTHORIZE_TIMEOUT_SECONDS = 60;
/// After the key comes up, how long the recognizers get to settle on finals.
static const double SETTLE_SECONDS = 1.5;

/// Ask once, block until answered. A CLI has no run loop of its own yet, so
/// the callbacks are waited on with semaphores rather than dispatched.
static void authorize(void) {
  dispatch_time_t deadline = dispatch_time(DISPATCH_TIME_NOW, AUTHORIZE_TIMEOUT_SECONDS * NSEC_PER_SEC);
  dispatch_semaphore_t speech = dispatch_semaphore_create(0);
  __block SFSpeechRecognizerAuthorizationStatus speechStatus = SFSpeechRecognizerAuthorizationStatusNotDetermined;
  [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
    speechStatus = status;
    dispatch_semaphore_signal(speech);
  }];
  if (dispatch_semaphore_wait(speech, deadline) != 0) fail(@"speech recognition permission was not answered");
  if (speechStatus != SFSpeechRecognizerAuthorizationStatusAuthorized) {
    fail([NSString stringWithFormat:@"speech recognition not authorized (%ld)", (long)speechStatus]);
  }

  dispatch_semaphore_t mic = dispatch_semaphore_create(0);
  __block BOOL micGranted = NO;
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                           completionHandler:^(BOOL granted) {
                             micGranted = granted;
                             dispatch_semaphore_signal(mic);
                           }];
  if (dispatch_semaphore_wait(mic, deadline) != 0) fail(@"microphone permission was not answered");
  if (!micGranted) fail(@"microphone not authorized");
}

/// One recognizer, its request, its task, and what it has heard so far.
@interface Ear : NSObject
@property(nonatomic, strong) NSString *locale;
@property(nonatomic, strong) SFSpeechRecognizer *recognizer;
@property(nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *request;
@property(nonatomic, strong) SFSpeechRecognitionTask *task;
@property(nonatomic, copy) NSString *lastText;
@property(nonatomic, copy) NSString *finalText; // nil until the recognizer settled
@end
@implementation Ear
@end

@interface Listener : NSObject
/// Words the recognizers should expect — agent, workspace and preset names.
@property(nonatomic, copy) NSArray<NSString *> *hints;
- (instancetype)initWithLocales:(NSArray<NSString *> *)locales allowServer:(BOOL)allowServer;
- (void)start;
- (void)stop;
- (void)recognizeFile:(NSString *)path;
- (void)streamFile:(NSString *)path;
@end

@implementation Listener {
  AVAudioEngine *_engine;
  NSArray<Ear *> *_ears;
  BOOL _finished;
  BOOL _stopping;
  BOOL _onDevice;
}

- (instancetype)initWithLocales:(NSArray<NSString *> *)locales allowServer:(BOOL)allowServer {
  self = [super init];
  if (!self) return nil;
  _engine = [[AVAudioEngine alloc] init];
  NSMutableArray<Ear *> *ears = [NSMutableArray array];
  BOOL onDevice = YES;
  for (NSString *locale in locales) {
    SFSpeechRecognizer *recognizer =
        [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:locale]];
    if (!recognizer) fail([NSString stringWithFormat:@"no recognizer for locale %@", locale]);
    if (!recognizer.isAvailable) fail([NSString stringWithFormat:@"recognizer for %@ is not available", locale]);
    BOOL local = recognizer.supportsOnDeviceRecognition && !allowServer;
    if (!local && !allowServer) {
      fail([NSString stringWithFormat:@"on-device recognition for %@ is not installed — enable it under "
                                      @"System Settings › Keyboard › Dictation, or pass --allow-server",
                                      locale]);
    }
    onDevice = onDevice && local;
    Ear *ear = [[Ear alloc] init];
    ear.locale = locale;
    ear.recognizer = recognizer;
    ear.request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    ear.request.shouldReportPartialResults = YES;
    ear.request.requiresOnDeviceRecognition = local;
    ear.request.taskHint = SFSpeechRecognitionTaskHintDictation;
    ear.lastText = @"";
    [ears addObject:ear];
  }
  _ears = ears;
  _onDevice = onDevice;
  emit(@{@"ready" : @YES, @"locales" : locales, @"onDevice" : @(onDevice)});
  return self;
}

- (void)startTasks {
  for (Ear *ear in _ears) {
    // Hints go to the English ear only. Measured 2026-09-06: with two
    // on-device recognizers on one microphone, giving BOTH contextualStrings
    // makes one of them die at once with 1110 "no speech detected"; and the
    // zh-CN ear never spelled an English name right with hints anyway — that
    // is the whole reason the English ear exists.
    if (self.hints.count > 0 && [ear.locale hasPrefix:@"en"]) ear.request.contextualStrings = self.hints;
    __weak Listener *weakSelf = self;
    ear.task = [ear.recognizer recognitionTaskWithRequest:ear.request
                                            resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
                                              [weakSelf ear:ear heard:result error:error];
                                            }];
  }
}

- (void)start {
  AVAudioInputNode *input = _engine.inputNode;
  AVAudioFormat *format = [input outputFormatForBus:0];
  NSArray<Ear *> *ears = _ears;
  BOOL meter = getenv("CR_LISTEN_METER") != NULL;
  __block double peakSinceReport = 0;
  __block NSTimeInterval lastReport = [NSDate timeIntervalSinceReferenceDate];
  AVAudioFile *dump = nil;
  const char *dumpPath = getenv("CR_LISTEN_DUMP");
  if (dumpPath) {
    NSError *dumpError = nil;
    dump = [[AVAudioFile alloc] initForWriting:[NSURL fileURLWithPath:[NSString stringWithUTF8String:dumpPath]]
                                      settings:format.settings
                                         error:&dumpError];
    if (!dump) fprintf(stderr, "dump: %s\n", dumpError.localizedDescription.UTF8String);
  }
  [input installTapOnBus:0
              bufferSize:1024
                  format:format
                   block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
                     for (Ear *ear in ears) [ear.request appendAudioPCMBuffer:buffer];
                     if (dump) [dump writeFromBuffer:buffer error:nil];
                     if (!meter || !buffer.floatChannelData) return;
                     float *samples = buffer.floatChannelData[0];
                     for (AVAudioFrameCount i = 0; i < buffer.frameLength; i++) {
                       double v = fabs(samples[i]);
                       if (v > peakSinceReport) peakSinceReport = v;
                     }
                     NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
                     if (now - lastReport >= 1.0) {
                       fprintf(stderr, "meter peak=%.4f sr=%.0f ch=%u\n", peakSinceReport, format.sampleRate,
                               (unsigned)format.channelCount);
                       peakSinceReport = 0;
                       lastReport = now;
                     }
                   }];
  [_engine prepare];
  NSError *error = nil;
  if (![_engine startAndReturnError:&error]) {
    fail([NSString stringWithFormat:@"audio engine failed to start: %@", error.localizedDescription]);
  }
  [self startTasks];
}

/// Recognize a recorded file (primary locale only) — the diagnostic that
/// separates "the recognizer cannot hear this audio" from "the microphone
/// path is wrong", and the hook a test can use without a microphone at all.
- (void)recognizeFile:(NSString *)path {
  Ear *ear = _ears.firstObject;
  SFSpeechURLRecognitionRequest *request =
      [[SFSpeechURLRecognitionRequest alloc] initWithURL:[NSURL fileURLWithPath:path]];
  request.shouldReportPartialResults = YES;
  request.requiresOnDeviceRecognition = _onDevice;
  request.taskHint = SFSpeechRecognitionTaskHintDictation;
  if (self.hints.count > 0) request.contextualStrings = self.hints;
  _ears = @[ ear ];
  __weak Listener *weakSelf = self;
  ear.task = [ear.recognizer recognitionTaskWithRequest:request
                                          resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
                                            [weakSelf ear:ear heard:result error:error];
                                          }];
}

/// Push a recorded file through the SAME buffer requests the microphone
/// uses, in real-time-sized chunks, then endAudio as ⌘-up would. This is the
/// live code path with known-good audio: if it recognizes, the feed is right
/// and a failing live run is acoustics; if it does not, the feed is wrong.
- (void)streamFile:(NSString *)path {
  NSError *error = nil;
  AVAudioFile *file = [[AVAudioFile alloc] initForReading:[NSURL fileURLWithPath:path] error:&error];
  if (!file) fail([NSString stringWithFormat:@"cannot read %@: %@", path, error.localizedDescription]);
  [self startTasks];
  NSArray<Ear *> *ears = _ears;
  AVAudioFormat *format = file.processingFormat;
  __weak Listener *weakSelf = self;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    const AVAudioFrameCount chunk = 1024;
    while (YES) {
      AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:chunk];
      NSError *readError = nil;
      if (![file readIntoBuffer:buffer frameCount:chunk error:&readError] || buffer.frameLength == 0) break;
      for (Ear *ear in ears) [ear.request appendAudioPCMBuffer:buffer];
      usleep((useconds_t)(1e6 * buffer.frameLength / format.sampleRate));
    }
    dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf stop]; });
  });
}

- (void)ear:(Ear *)ear heard:(SFSpeechRecognitionResult *)result error:(NSError *)error {
  if (_finished) return;
  BOOL primary = ear == _ears.firstObject;
  if (result) {
    NSString *text = result.bestTranscription.formattedString;
    if (result.isFinal) {
      ear.finalText = text;
      [self finishIfAllHeard];
      return;
    }
    if (![text isEqualToString:ear.lastText]) {
      ear.lastText = text;
      if (primary) emit(@{@"partial" : text});
    }
  }
  if (error) {
    // 1110 ("no speech detected") and 216 (cancelled) end an ear with what
    // it had; anything else is a real fault, and only the primary's is fatal
    // — an alternate that fails is just an alternate we do not have.
    if (getenv("CR_LISTEN_METER")) {
      fprintf(stderr, "[%s] task error domain=%s code=%ld %s\n", ear.locale.UTF8String, error.domain.UTF8String,
              (long)error.code, error.localizedDescription.UTF8String);
    }
    if (error.code != 1110 && error.code != 216 && primary) {
      fail([NSString stringWithFormat:@"recognition failed: %@", error.localizedDescription]);
    }
    ear.finalText = ear.lastText;
    [self finishIfAllHeard];
  }
}

/// The key came up: stop feeding audio and let every recognizer settle on a
/// final. They usually answer within ~300 ms; the deadline is for the ones
/// that do not, whose last partial becomes their final rather than nothing.
- (void)stop {
  // SIGINT then SIGTERM a moment later is an ordinary supervisor pattern, and
  // the max-seconds timer may fire in the same instant: teardown runs once.
  if (_finished || _stopping) return;
  _stopping = YES;
  if (_engine.isRunning) {
    [_engine.inputNode removeTapOnBus:0];
    [_engine stop];
  }
  for (Ear *ear in _ears) [ear.request endAudio];
  __weak Listener *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(SETTLE_SECONDS * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    Listener *self = weakSelf;
    if (!self || self->_finished) return;
    for (Ear *ear in self->_ears) {
      if (!ear.finalText) ear.finalText = ear.lastText;
    }
    [self finish];
  });
}

- (void)finishIfAllHeard {
  if (!_stopping) return; // finals before the key is up: keep listening
  for (Ear *ear in _ears) {
    if (!ear.finalText) return;
  }
  [self finish];
}

- (void)finish {
  if (_finished) return;
  _finished = YES;
  NSCharacterSet *ws = [NSCharacterSet whitespaceAndNewlineCharacterSet];
  NSMutableDictionary *out = [NSMutableDictionary dictionary];
  NSMutableDictionary *alternates = [NSMutableDictionary dictionary];
  for (Ear *ear in _ears) {
    [ear.task cancel];
    NSString *text = [(ear.finalText ?: ear.lastText) stringByTrimmingCharactersInSet:ws];
    if (ear == _ears.firstObject) out[@"final"] = text;
    else alternates[ear.locale] = text;
  }
  if (alternates.count > 0) out[@"alternates"] = alternates;
  emit(out);
  exit(0);
}

@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSMutableArray<NSString *> *locales = [NSMutableArray array];
    double maxSeconds = 30.0;
    BOOL allowServer = NO;
    NSString *file = nil;
    BOOL streamFile = NO;
    NSMutableArray<NSString *> *hints = [NSMutableArray array];
    for (int i = 1; i < argc; i++) {
      NSString *arg = [NSString stringWithUTF8String:argv[i]];
      if ([arg isEqualToString:@"--hint"] && i + 1 < argc) {
        [hints addObject:[NSString stringWithUTF8String:argv[++i]]];
      } else if ([arg isEqualToString:@"--locale"] && i + 1 < argc) {
        [locales addObject:[NSString stringWithUTF8String:argv[++i]]];
      } else if ([arg isEqualToString:@"--max-seconds"] && i + 1 < argc) {
        maxSeconds = atof(argv[++i]);
      } else if ([arg isEqualToString:@"--allow-server"]) {
        allowServer = YES;
      } else if ([arg isEqualToString:@"--file"] && i + 1 < argc) {
        file = [NSString stringWithUTF8String:argv[++i]];
      } else if ([arg isEqualToString:@"--stream-file"] && i + 1 < argc) {
        file = [NSString stringWithUTF8String:argv[++i]];
        streamFile = YES;
      }
    }
    if (locales.count == 0) [locales addObject:@"zh-CN"];

    // Signals first, permission second: the key can come up while the
    // permission dialog is still on screen, and that must end this process
    // quietly (an empty final) rather than let the default SIGINT kill it
    // before it has said anything. The sources live on a background queue
    // because authorize() blocks the main thread; once listening, the stop is
    // handed to main, where the audio engine lives.
    __block Listener *listener = nil;
    dispatch_queue_t signals = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);
    void (^onStop)(void) = ^{
      Listener *live = listener;
      if (!live) {
        emit(@{@"final" : @""});
        exit(0);
      }
      dispatch_async(dispatch_get_main_queue(), ^{ [live stop]; });
    };
    signal(SIGINT, SIG_IGN);
    dispatch_source_t sigint = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGINT, 0, signals);
    dispatch_source_set_event_handler(sigint, onStop);
    dispatch_resume(sigint);
    signal(SIGTERM, SIG_IGN);
    dispatch_source_t sigterm = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, signals);
    dispatch_source_set_event_handler(sigterm, onStop);
    dispatch_resume(sigterm);

    authorize();
    listener = [[Listener alloc] initWithLocales:locales allowServer:allowServer];
    listener.hints = hints;
    if (file) {
      // Diagnostic / test mode: no microphone — the file ends itself.
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(maxSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        fail(@"file recognition timed out");
      });
      if (streamFile) [listener streamFile:file];
      else {
        [listener recognizeFile:file];
      }
      [[NSRunLoop mainRunLoop] run];
      return 0;
    }

    // A key that never lifts (window lost focus mid-hold) must not listen forever.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(maxSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      [listener stop];
    });

    [listener start];
    [[NSRunLoop mainRunLoop] run];
  }
  return 0;
}
