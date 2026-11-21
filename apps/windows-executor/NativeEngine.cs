using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;

namespace IntentBridge.Executor;

/// <summary>
/// P/Invoke bridge to the shared Rust execution engine (ib_runtime.dll).
/// All flow semantics stay in Rust; this class never re-implements them.
/// </summary>
public sealed class NativeEngine : IDisposable
{
    private readonly IntPtr _engine;

    public NativeEngine(string dllPath)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(dllPath));
        if (directory is not null) NativeLibrary.Load(dllPath);
        _engine = Native.ib_new();
        if (_engine == IntPtr.Zero) throw new InvalidOperationException("ib_new failed");
    }

    public JsonNode? Command(JsonNode payload)
    {
        var json = payload.ToJsonString();
        var bytes = Encoding.UTF8.GetBytes(json);
        var buffer = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, buffer, bytes.Length);
            var length = Native.ib_cmd(_engine, buffer, (nuint)bytes.Length);
            var pointer = Native.ib_response_ptr();
            if (pointer == IntPtr.Zero) return null;
            var response = new byte[(int)length];
            Marshal.Copy(pointer, response, 0, (int)length);
            return JsonNode.Parse(Encoding.UTF8.GetString(response));
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public void Dispose() => Native.ib_destroy(_engine);

    private static class Native
    {
        [DllImport("ib_runtime", CallingConvention = CallingConvention.Cdecl)]
        public static extern IntPtr ib_new();

        [DllImport("ib_runtime", CallingConvention = CallingConvention.Cdecl)]
        public static extern void ib_destroy(IntPtr engine);

        [DllImport("ib_runtime", CallingConvention = CallingConvention.Cdecl)]
        public static extern nuint ib_cmd(IntPtr engine, IntPtr pointer, nuint length);

        [DllImport("ib_runtime", CallingConvention = CallingConvention.Cdecl)]
        public static extern IntPtr ib_response_ptr();

        [DllImport("ib_runtime", CallingConvention = CallingConvention.Cdecl)]
        public static extern nuint ib_response_len();
    }
}
