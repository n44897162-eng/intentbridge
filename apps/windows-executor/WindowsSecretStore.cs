using System.Runtime.InteropServices;

namespace IntentBridge.Executor;

/// <summary>
/// Resolves secret:// aliases from Windows Credential Manager generic
/// credentials named IntentBridge:&lt;alias&gt;. No plaintext is stored on disk.
/// </summary>
internal static class WindowsSecretStore
{
    private const uint CredTypeGeneric = 1;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32", EntryPoint = "CredFree")]
    private static extern void CredFree(IntPtr credential);

    public static string? Resolve(string alias)
    {
        if (string.IsNullOrWhiteSpace(alias)) return null;
        if (!CredRead($"IntentBridge:{alias}", CredTypeGeneric, 0, out var pointer)) return null;
        try
        {
            var credential = Marshal.PtrToStructure<Credential>(pointer);
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0)
            {
                return null;
            }
            var bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            return System.Text.Encoding.Unicode.GetString(bytes).TrimEnd('\0');
        }
        finally
        {
            CredFree(pointer);
        }
    }
}
