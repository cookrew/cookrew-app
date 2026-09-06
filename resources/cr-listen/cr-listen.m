// cr-listen — the Mac's ear for Sous.
//
// Electron's renderer has no working SpeechRecognition (Chromium's needs a
// Google key), and macOS system dictation only types into text fields, of
// which the zoomed xterm is not one. So the desktop listens through Apple's
// on-device recognizer instead: no key, no cloud, zh-CN and en-US resident on
// the machine, partial results as they form.
//
// Objective-C rather than Swift on purpose: it builds with `clang` from any
// Command Line Tools install, whereas swiftc on this machine is broken by a
// stale SwiftBridging modulemap (a root-owned fix). A postinstall step must not
// depend on the owner having repaired their toolchain.
//
// Contract (main spawns it on ⌘-down, SIGINTs it on ⌘-up):
//   stdout, one JSON object per line
//     {"ready":true,"locale":"zh-CN","onDevice":true}
//     {"partial":"切换工作台到"}          as the sentence forms
//     {"final":"切换工作台到 cookrew dev"}  once, then exit 0
//     {"error":"<reason>"}                 then exit 1
//   flags
//     --locale zh-CN        recognizer locale (default zh-CN)
//     --max-seconds 30      hard stop, for a held key that never lifts
//     --allow-server        permit Apple's server when on-device is unavailable
//                           (off by default: the words must stay on the Mac)
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

@interface Listener : NSObject
- (instancetype)initWithLocale:(NSString *)locale allowServer:(BOOL)allowServer;
/// Words the recognizer should expect — agent, workspace and preset names.
/// A zh-CN recognizer turns "Conductor" into 收入条 without them.
@property(nonatomic, copy) NSArray<NSString *> *hints;
- (void)start;
- (void)stop;
- (void)recognizeFile:(NSString *)path;
- (void)streamFile:(NSString *)path;
- (void)handleResult:(SFSpeechRecognitionResult *)result error:(NSError *)taskError;
@end

@implementation Listener {
  AVAudioEngine *_engine;
  SFSpeechAudioBufferRecognitionRequest *_request;
  SFSpeechRecognizer *_recognizer;
  SFSpeechRecognitionTask *_task;
  NSString *_lastText;
  BOOL _finished;
  BOOL _stopping;
  BOOL _onDevice;
}

- (instancetype)initWithLocale:(NSString *)locale allowServer:(BOOL)allowServer {
  self = [super init];
  if (!self) return nil;
  _engine = [[AVAudioEngine alloc] init];
  _request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
  _lastText = @"";
  _recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:locale]];
  if (!_recognizer) fail([NSString stringWithFormat:@"no recognizer for locale %@", locale]);
  if (!_recognizer.isAvailable) fail([NSString stringWithFormat:@"recognizer for %@ is not available", locale]);

  BOOL onDevice = _recognizer.supportsOnDeviceRecognition && !allowServer;
  if (!onDevice && !allowServer) {
    fail([NSString stringWithFormat:@"on-device recognition for %@ is not installed — enable it under "
                                    @"System Settings › Keyboard › Dictation, or pass --allow-server",
                                    locale]);
  }
  _onDevice = onDevice;
  _request.shouldReportPartialResults = YES;
  _request.requiresOnDeviceRecognition = onDevice;
  _request.taskHint = SFSpeechRecognitionTaskHintDictation;
  emit(@{@"ready" : @YES, @"locale" : locale, @"onDevice" : @(onDevice)});
  return self;
}

/// Recognize a recorded file instead of the microphone — the diagnostic that
/// separates "the recognizer cannot hear this audio" from "the microphone
/// path is wrong", and the hook a test can use without a microphone at all.
- (void)recognizeFile:(NSString *)path {
  SFSpeechURLRecognitionRequest *request =
      [[SFSpeechURLRecognitionRequest alloc] initWithURL:[NSURL fileURLWithPath:path]];
  request.shouldReportPartialResults = YES;
  request.requiresOnDeviceRecognition = _onDevice;
  request.taskHint = SFSpeechRecognitionTaskHintDictation;
  if (self.hints.count > 0) request.contextualStrings = self.hints;
  __weak Listener *weakSelf = self;
  _task = [_recognizer recognitionTaskWithRequest:request
                                    resultHandler:^(SFSpeechRecognitionResult *result, NSError *taskError) {
                                      [weakSelf handleResult:result error:taskError];
                                    }];
}

/// Push a recorded file through the SAME buffer request the microphone uses,
/// in real-time-sized chunks, then endAudio as ⌘-up would. This is the live
/// code path with known-good audio: if it recognizes, the feed is right and a
/// failing live run is acoustics; if it does not, the feed is wrong.
- (void)streamFile:(NSString *)path {
  NSError *error = nil;
  AVAudioFile *file = [[AVAudioFile alloc] initForReading:[NSURL fileURLWithPath:path] error:&error];
  if (!file) fail([NSString stringWithFormat:@"cannot read %@: %@", path, error.localizedDescription]);
  if (self.hints.count > 0) _request.contextualStrings = self.hints;
  __weak Listener *weakSelf = self;
  _task = [_recognizer recognitionTaskWithRequest:_request
                                    resultHandler:^(SFSpeechRecognitionResult *result, NSError *taskError) {
                                      [weakSelf handleResult:result error:taskError];
                                    }];
  SFSpeechAudioBufferRecognitionRequest *request = _request;
  AVAudioFormat *format = file.processingFormat;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    const AVAudioFrameCount chunk = 1024;
    while (YES) {
      AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:chunk];
      NSError *readError = nil;
      if (![file readIntoBuffer:buffer frameCount:chunk error:&readError] || buffer.frameLength == 0) break;
      [request appendAudioPCMBuffer:buffer];
      usleep((useconds_t)(1e6 * buffer.frameLength / format.sampleRate));
    }
    [request endAudio];
  });
}

- (void)handleResult:(SFSpeechRecognitionResult *)result error:(NSError *)taskError {
  if (result) {
    NSString *text = result.bestTranscription.formattedString;
    if (result.isFinal) {
      [self finish:text];
      return;
    }
    if (![text isEqualToString:_lastText]) {
      _lastText = text;
      emit(@{@"partial" : text});
    }
  }
  if (taskError) {
    if (_finished) return;
    if (getenv("CR_LISTEN_METER")) {
      fprintf(stderr, "task error domain=%s code=%ld %s\n", taskError.domain.UTF8String, (long)taskError.code,
              taskError.localizedDescription.UTF8String);
    }
    if (taskError.code == 1110 || taskError.code == 216) {
      [self finish:_lastText];
      return;
    }
    fail([NSString stringWithFormat:@"recognition failed: %@", taskError.localizedDescription]);
  }
}

- (void)start {
  if (self.hints.count > 0) _request.contextualStrings = self.hints;
  AVAudioInputNode *input = _engine.inputNode;
  AVAudioFormat *format = [input outputFormatForBus:0];
  SFSpeechAudioBufferRecognitionRequest *request = _request;
  // --meter: a level line on stderr every ~second, so "it heard nothing" can
  // be told apart from "the microphone delivered silence" without guessing.
  BOOL meter = getenv("CR_LISTEN_METER") != NULL;
  __block double peakSinceReport = 0;
  __block NSTimeInterval lastReport = [NSDate timeIntervalSinceReferenceDate];
  // CR_LISTEN_DUMP=<path.caf>: also write what the tap delivers, so the very
  // same bytes can be fed back through --file. If the file recognizes and the
  // live run does not, the fault is in the feed, not the sound.
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
                     [request appendAudioPCMBuffer:buffer];
                     if (dump) [dump writeFromBuffer:buffer error:nil];
                     if (!meter || !buffer.floatChannelData) return;
                     float *samples = buffer.floatChannelData[0];
                     for (AVAudioFrameCount i = 0; i < buffer.frameLength; i++) {
                       double v = fabs(samples[i]);
                       if (v > peakSinceReport) peakSinceReport = v;
                     }
                     NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
                     if (now - lastReport >= 1.0) {
                       fprintf(stderr, "meter peak=%.4f sr=%.0f ch=%u\n", peakSinceReport,
                               format.sampleRate, (unsigned)format.channelCount);
                       peakSinceReport = 0;
                       lastReport = now;
                     }
                   }];
  [_engine prepare];
  NSError *error = nil;
  if (![_engine startAndReturnError:&error]) {
    fail([NSString stringWithFormat:@"audio engine failed to start: %@", error.localizedDescription]);
  }
  // A cancelled task after endAudio is the normal way out; the final has been
  // emitted by then. Before that, 1110 ("no speech detected") and 216
  // (cancelled) are an empty final, not a failure. Anything else is real —
  // see handleResult.
  __weak Listener *weakSelf = self;
  _task = [_recognizer recognitionTaskWithRequest:_request
                                    resultHandler:^(SFSpeechRecognitionResult *result, NSError *taskError) {
                                      [weakSelf handleResult:result error:taskError];
                                    }];
}

/// The key came up: stop feeding audio and let the recognizer settle on a
/// final. It usually answers within ~300 ms; the deadline is for the case
/// where it does not, so the last partial becomes the final rather than
/// nothing.
- (void)stop {
  // SIGINT then SIGTERM a moment later is an ordinary supervisor pattern, and
  // the max-seconds timer may fire in the same instant: teardown runs once.
  if (_finished || _stopping) return;
  _stopping = YES;
  [_engine.inputNode removeTapOnBus:0];
  [_engine stop];
  [_request endAudio];
  __weak Listener *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    Listener *self = weakSelf;
    if (self && !self->_finished) [self finish:self->_lastText];
  });
}

- (void)finish:(NSString *)text {
  if (_finished) return;
  _finished = YES;
  [_task cancel];
  NSString *trimmed = [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  emit(@{@"final" : trimmed});
  exit(0);
}

@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *locale = @"zh-CN";
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
        locale = [NSString stringWithUTF8String:argv[++i]];
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

    // Signals first, permission second: the key can come up while the
    // permission dialog is still on screen, and that must end this process
    // quietly (an empty final) rather than let the default SIGINT kill it
    // before it has said anything.
    // The sources live on a background queue because authorize() blocks the
    // main thread; a signal that arrives while the dialog is up ends the
    // process from there. Once listening, the stop is handed to main, where
    // the audio engine lives.
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
    listener = [[Listener alloc] initWithLocale:locale allowServer:allowServer];
    listener.hints = hints;
    if (file) {
      // Diagnostic / test mode: no microphone, no signals — the file ends itself.
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(maxSeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        fail(@"file recognition timed out");
      });
      if (streamFile) [listener streamFile:file];
      else [listener recognizeFile:file];
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
