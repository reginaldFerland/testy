using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// The extension decodes this process's output as UTF-8. Replace the writers rather
// than the console code page, which is shared and may not exist for a hidden console.
Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
try
{
    if (!OperatingSystem.IsWindows()) { throw new PlatformNotSupportedException("The Windows process owner requires Windows."); }
    if (args.Length == 0) { throw new ArgumentException("Expected an executable and its arguments."); }
    return ProcessOwner.Run(args);
}
catch (Exception error)
{
    // The extension recognizes this exit code and prefix; keep them in sync
    // with ProcessHostFailure in src/services/process.ts.
    Console.Error.WriteLine($"Testy could not own the process tree: {error}");
    return ProcessOwner.HostFailure;
}

static partial class ProcessOwner
{
    /// <summary>Distinct from MTP and test host exit codes.</summary>
    public const int HostFailure = 125;
    private const int MaxCommandLine = 32766;
    /// <summary>The extension passes variables that would inject code into this .NET process under this prefix.</summary>
    private const string RestoredPrefix = "TESTY_CHILD_ENV_";
    private static readonly TimeSpan TerminationTimeout = TimeSpan.FromSeconds(10);

    public static int Run(string[] arguments)
    {
        var gate = new object();
        var job = Native.CreateJobObjectW(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        ProcessInformation process = default;
        var handles = new List<IntPtr>();
        var attributes = IntPtr.Zero;
        var handleList = IntPtr.Zero;
        var commandLine = IntPtr.Zero;
        var environment = IntPtr.Zero;
        try
        {
            var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 /* KILL_ON_JOB_CLOSE */ } };
            Check(Native.SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()));
            var command = new StringBuilder(string.Join(" ", arguments.Select(Quote)));
            if (command.Length > MaxCommandLine)
            {
                throw new ArgumentException($"The command line is {command.Length} characters; Windows allows at most {MaxCommandLine}. Run fewer tests at once or shorten testy.testArguments.");
            }
            using var input = File.OpenHandle("NUL", FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var discard = File.OpenHandle("NUL", FileMode.Open, FileAccess.Write, FileShare.ReadWrite);
            IntPtr Inherit(IntPtr handle)
            {
                Check(Native.DuplicateHandle(Native.GetCurrentProcess(), handle, Native.GetCurrentProcess(), out var inherited, 0, true, 2));
                handles.Add(inherited);
                return inherited;
            }
            // A missing or invalid standard handle would otherwise duplicate the
            // current-process pseudo-handle (-1) into the child as its output.
            IntPtr Standard(int kind)
            {
                var handle = Native.GetStdHandle(kind);
                return handle == IntPtr.Zero || handle == new IntPtr(-1) ? discard.DangerousGetHandle() : handle;
            }
            var startup = new StartupInfoEx
            {
                StartupInfo = new StartupInfo
                {
                    Size = (uint)Marshal.SizeOf<StartupInfoEx>(), Flags = 0x100 /* USESTDHANDLES */,
                    Input = Inherit(input.DangerousGetHandle()), Output = Inherit(Standard(-11)), Error = Inherit(Standard(-12))
                }
            };
            // Inherit only the three duplicated stdio handles, not every
            // inheritable handle this process received from the extension host.
            var size = IntPtr.Zero;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(Native.InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
            handleList = Marshal.AllocHGlobal(IntPtr.Size * handles.Count);
            for (var index = 0; index < handles.Count; index++) { Marshal.WriteIntPtr(handleList, index * IntPtr.Size, handles[index]); }
            Check(Native.UpdateProcThreadAttribute(attributes, 0, 0x20002 /* HANDLE_LIST */, handleList,
                IntPtr.Size * handles.Count, IntPtr.Zero, IntPtr.Zero));
            startup.AttributeList = attributes;
            // Suspend before assignment: even a very short-lived parent cannot
            // create an unowned child between CreateProcess and job assignment.
            // CreateProcess with a null application name searches this process's
            // directory and the current directory (the workspace) before PATH.
            // Name the file explicitly. The environment is rebuilt for the same
            // reason: startup-hook variables belong to the command, not to this host.
            commandLine = Marshal.StringToHGlobalUni(command.ToString());
            environment = Marshal.StringToHGlobalUni(CommandEnvironment());
            Check(Native.CreateProcessW(ResolveApplication(arguments[0]), commandLine, IntPtr.Zero, IntPtr.Zero, true,
                0x4 | 0x08000000 | 0x80000 | 0x400 /* SUSPENDED | NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | UNICODE_ENVIRONMENT */,
                environment, null, ref startup, out process));
            if (!Native.AssignProcessToJobObject(job, process.Process))
            {
                var error = Marshal.GetLastWin32Error();
                // Best effort: the child is still suspended and has run no code. If terminating it fails
                // too, the assignment error is the one to report; there is nothing further to try.
                _ = Native.TerminateProcess(process.Process, 1);
                throw new Win32Exception(error);
            }
            Check(Native.ResumeThread(process.Thread) != uint.MaxValue);
            // stdin belongs to the owner protocol; tests receive NUL. EOF also
            // cancels the job when the extension host disappears unexpectedly.
            _ = Task.Run(() =>
            {
                try { Console.In.ReadLine(); } catch (IOException) { }
                lock (gate) { if (job != IntPtr.Zero) { Native.TerminateJobObject(job, 1); } }
            });
            Check(Native.WaitForSingleObject(process.Process, uint.MaxValue) == 0);
            Check(Native.GetExitCodeProcess(process.Process, out var exitCode));
            Check(Native.TerminateJobObject(job, 1));
            var deadline = Environment.TickCount64 + (long)TerminationTimeout.TotalMilliseconds;
            while (true)
            {
                Check(Native.QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero));
                if (accounting.ActiveProcesses == 0) { break; }
                if (Environment.TickCount64 > deadline)
                {
                    // Closing the job below kills any stragglers; the command's own result stands.
                    Console.Error.WriteLine($"Testy: {accounting.ActiveProcesses} process(es) in the job did not exit within {TerminationTimeout.TotalSeconds:0} seconds of termination.");
                    break;
                }
                Thread.Sleep(5);
            }
            return unchecked((int)exitCode);
        }
        finally
        {
            lock (gate) { Native.CloseHandle(job); job = IntPtr.Zero; }
            if (process.Thread != IntPtr.Zero) { Native.CloseHandle(process.Thread); }
            if (process.Process != IntPtr.Zero) { Native.CloseHandle(process.Process); }
            foreach (var handle in handles) { Native.CloseHandle(handle); }
            if (attributes != IntPtr.Zero) { Native.DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (handleList != IntPtr.Zero) { Marshal.FreeHGlobal(handleList); }
            if (commandLine != IntPtr.Zero) { Marshal.FreeHGlobal(commandLine); }
            if (environment != IntPtr.Zero) { Marshal.FreeHGlobal(environment); }
        }
    }

    /// <summary>Explicit paths are used as given; a bare name is looked up on PATH alone, never in the current directory.</summary>
    internal static string ResolveApplication(string command)
    {
        if (command.IndexOfAny(['\\', '/', ':']) >= 0) { return Path.GetFullPath(command); }
        var dot = command.IndexOf('.', 1);
        string[] names = dot >= 0 && dot < command.Length - 1 ? [command] : [command + ".com", command + ".exe"];
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!Path.IsPathFullyQualified(directory)) { continue; }
            foreach (var name in names)
            {
                var candidate = Path.Combine(directory, name);
                if (File.Exists(candidate)) { return candidate; }
            }
        }
        throw new FileNotFoundException($"'{command}' was not found on PATH.");
    }

    /// <summary>The child's environment block: ours, with restored variables replacing their prefixed copies.</summary>
    private static string CommandEnvironment()
    {
        var variables = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            var name = (string)entry.Key;
            if (!name.StartsWith(RestoredPrefix, StringComparison.OrdinalIgnoreCase)) { variables.TryAdd(name, (string?)entry.Value ?? ""); }
        }
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            var name = (string)entry.Key;
            if (name.StartsWith(RestoredPrefix, StringComparison.OrdinalIgnoreCase)) { variables[name[RestoredPrefix.Length..]] = (string?)entry.Value ?? ""; }
        }
        var block = new StringBuilder();
        foreach (var (name, value) in variables) { block.Append(name).Append('=').Append(value).Append('\0'); }
        return block.Append('\0').ToString();
    }

    private static void Check(bool succeeded)
    {
        if (!succeeded) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
    }

    internal static string Quote(string argument)
    {
        var result = new StringBuilder("\"");
        var slashes = 0;
        foreach (var character in argument)
        {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            result.Append(character); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public uint Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong Reads, Writes, Others, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    private static partial class Native
    {
        [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
        public static partial IntPtr CreateJobObjectW(IntPtr attributes, string? name);
        [LibraryImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static partial bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits limits, uint size);
        [LibraryImport("kernel32.dll", StringMarshalling = StringMarshalling.Utf16, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static partial bool CreateProcessW(string? application, IntPtr command, IntPtr processAttributes, IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string? directory, ref StartupInfoEx startup, out ProcessInformation process);
        [LibraryImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static partial bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [LibraryImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static partial bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [LibraryImport("kernel32.dll")]
        public static partial void DeleteProcThreadAttributeList(IntPtr list);
        [LibraryImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static partial bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [LibraryImport("kernel32.dll", SetLastError = true)]
        public static partial uint ResumeThread(IntPtr thread);
        [LibraryImport("kernel32.dll", SetLastError = true)]
        public static partial uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [LibraryImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static partial bool GetExitCodeProcess(IntPtr process, out uint code);
        [LibraryImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static partial bool TerminateProcess(IntPtr process, uint code);
        [LibraryImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static partial bool TerminateJobObject(IntPtr job, uint code);
        [LibraryImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static partial bool QueryInformationJobObject(IntPtr job, int informationClass, out Accounting accounting, uint size, IntPtr returned);
        [LibraryImport("kernel32.dll")]
        public static partial IntPtr GetCurrentProcess();
        [LibraryImport("kernel32.dll", SetLastError = true)]
        public static partial IntPtr GetStdHandle(int kind);
        [LibraryImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static partial bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access,
            [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
        [LibraryImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static partial bool CloseHandle(IntPtr handle);
    }
}
