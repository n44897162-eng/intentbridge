using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace IntentBridge.Executor;

/// <summary>Named-pipe server, one client at a time, newline-delimited JSON.</summary>
public sealed class IpcServer : IDisposable
{
    private readonly IpcEndpoint _endpoint;
    private readonly UiaProvider _uia;
    private readonly NativeEngine _engine;

    public IpcServer(IpcEndpoint endpoint, UiaProvider uia, NativeEngine engine)
    {
        _endpoint = endpoint;
        _uia = uia;
        _engine = engine;
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            using var pipe = CreatePipe();
            await pipe.WaitForConnectionAsync(cancellationToken);
            using var reader = new StreamReader(pipe, new UTF8Encoding(false));
            using var writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };
            while (!cancellationToken.IsCancellationRequested && pipe.IsConnected)
            {
                var line = await reader.ReadLineAsync(cancellationToken);
                if (line is null) break;
                var response = Handle(line);
                await writer.WriteLineAsync(JsonSerializer.Serialize(response));
            }
        }
    }

    private NamedPipeServerStream CreatePipe()
    {
        var security = new PipeSecurity();
        using var identity = WindowsIdentity.GetCurrent();
        var user = identity.User ?? throw new InvalidOperationException("missing user SID");
        security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(
            _endpoint.PipeName,
            PipeDirection.InOut,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            0,
            0,
            security);
    }

    private JsonObject Handle(string line)
    {
        string? id = null;
        try
        {
            var request = JsonNode.Parse(line)?.AsObject() ?? throw new InvalidOperationException("invalid request");
            id = request["id"]?.GetValue<string>();
            var token = request["token"]?.GetValue<string>();
            if (!ConstantTimeEquals(token ?? string.Empty, _endpoint.Token))
            {
                return Error(id, "IPC_UNAUTHORIZED", "invalid session token");
            }
            var command = request["command"]?.GetValue<string>() ?? throw new InvalidOperationException("missing command");
            switch (command)
            {
                case "scope":
                    return Success(id, _uia.Scope());
                case "snapshot":
                    return Success(id, _uia.Snapshot());
                case "facts":
                    return Success(id, _uia.Facts());
                case "act":
                    return Success(id, _uia.Act(request["request"] ?? throw new InvalidOperationException("missing request")));
                case "engine":
                    return Success(id, _engine.Command(request["payload"] ?? throw new InvalidOperationException("missing payload")));
                default:
                    return Error(id, "UNSUPPORTED_CAPABILITY", $"unknown command {command}");
            }
        }
        catch (Exception error)
        {
            return Error(id, "INTERNAL_ERROR", error.Message);
        }
    }

    private static bool ConstantTimeEquals(string provided, string expected)
    {
        var a = Encoding.UTF8.GetBytes(provided);
        var b = Encoding.UTF8.GetBytes(expected);
        return a.Length == b.Length && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(a, b);
    }

    private static JsonObject Success(string? id, object result) => new()
    {
        ["id"] = id,
        ["ok"] = true,
        ["result"] = JsonSerializer.SerializeToNode(result),
    };

    private static JsonObject Error(string? id, string code, string message) => new()
    {
        ["id"] = id,
        ["ok"] = false,
        ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
    };

    public void Dispose() => _engine.Dispose();
}
