using System.Security.Cryptography;

namespace IntentBridge.Executor;

/// <summary>One-time pipe endpoint + token, printed at startup.</summary>
public sealed class IpcEndpoint
{
    public required string PipeName { get; init; }
    public required string Token { get; init; }

    public static IpcEndpoint Create()
    {
        // 32 random bytes, base64url; the pipe name is also random so a stale
        // client cannot race another user's executor.
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
        var pipeName = "intentbridge-" + Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant();
        return new IpcEndpoint { PipeName = pipeName, Token = token };
    }
}
