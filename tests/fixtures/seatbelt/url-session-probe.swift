// Seatbelt probe: can a confined process make nsurlsessiond (a background
// URLSession) or its own in-process session reach a URL, and read the reply?
// Usage: bg-upload <background|ephemeral> <url> <upload-file> <identifier>
// Prints exactly one line: OK <status> <body> | ERR <domain> <code> | TIMEOUT
import Foundation

final class Probe: NSObject, URLSessionDataDelegate {
  var body = Data()
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    body.append(data)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error = error as NSError? {
      finish(session, "ERR \(error.domain) \(error.code)", 2)
    }
    let status = (task.response as? HTTPURLResponse)?.statusCode ?? -1
    finish(session, "OK \(status) \(String(decoding: body, as: UTF8.self))", 0)
  }
}

func finish(_ session: URLSession?, _ line: String, _ code: Int32) -> Never {
  // Cancel so a background task never outlives the probe inside nsurlsessiond.
  session?.invalidateAndCancel()
  print(line)
  fflush(stdout)
  exit(code)
}

let args = CommandLine.arguments
guard args.count == 5, let url = URL(string: args[2]) else { finish(nil, "USAGE", 64) }
let config = args[1] == "background"
  ? URLSessionConfiguration.background(withIdentifier: args[4])
  : URLSessionConfiguration.ephemeral
config.timeoutIntervalForRequest = 8
let probe = Probe()
let session = URLSession(configuration: config, delegate: probe, delegateQueue: nil)
var request = URLRequest(url: url)
request.httpMethod = "POST"
session.uploadTask(with: request, fromFile: URL(fileURLWithPath: args[3])).resume()
DispatchQueue.main.asyncAfter(deadline: .now() + 10) { finish(session, "TIMEOUT", 3) }
dispatchMain()
