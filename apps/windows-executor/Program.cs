using System.Text.Json;
using IntentBridge.Executor;

// The executor exposes a local JSON-lines protocol over a named pipe. It never
// listens on TCP and never accepts a caller without the one-time token.
var mode = args.FirstOrDefault() ?? "serve";
if (mode == "record")
{
    using var recorder = new UiaRecorder();
    await recorder.StreamAsync(Console.OpenStandardOutput(), CancellationToken.None);
    return;
}

var endpoint = IpcEndpoint.Create();
Console.WriteLine(JsonSerializer.Serialize(new
{
    endpoint = endpoint.PipeName,
    token = endpoint.Token,
    pid = Environment.ProcessId,
}));
Console.Out.Flush();

using var host = new IpcServer(endpoint, new UiaProvider(), new NativeEngine(Path.Combine(AppContext.BaseDirectory, "ib_runtime.dll")));
await host.RunAsync(CancellationToken.None);
