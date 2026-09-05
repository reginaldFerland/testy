using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

try
{
    if (!OperatingSystem.IsWindows()) { throw new PlatformNotSupportedException("The Windows process owner requires Windows."); }
    if (args.Length == 0) { throw new ArgumentException("Expected an executable and its arguments."); }
    return ProcessOwner.Run(args);
}
catch (Exception error)
{
    Console.Error.WriteLine($"Testy could not own the process tree: {error.Message}");
    return 1;
}

static class ProcessOwner
{
    public static int Run(string[] arguments)
    {
        var gate = new object();
        var job = Native.CreateJobObjectW(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        ProcessInformation process = default;
        var handles = new List<IntPtr>();
        try
        {
            var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 /* KILL_ON_JOB_CLOSE */ } };
            Check(Native.SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()));
            using var input = File.OpenHandle("NUL", FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            IntPtr Inherit(IntPtr handle)
            {
                Check(Native.DuplicateHandle(Native.GetCurrentProcess(), handle, Native.GetCurrentProcess(), out var inherited, 0, true, 2));
                handles.Add(inherited);
                return inherited;
            }
            var startup = new StartupInfo
            {
                Size = (uint)Marshal.SizeOf<StartupInfo>(), Flags = 0x100 /* USESTDHANDLES */,
                Input = Inherit(input.DangerousGetHandle()),
                Output = Inherit(Native.GetStdHandle(-11)), Error = Inherit(Native.GetStdHandle(-12))
            };
            var command = new StringBuilder(string.Join(" ", arguments.Select(Quote)));
            // Suspend before assignment: even a very short-lived parent cannot
            // create an unowned child between CreateProcess and job assignment.
            Check(Native.CreateProcessW(null, command, IntPtr.Zero, IntPtr.Zero, true,
                0x4 | 0x08000000 /* SUSPENDED | NO_WINDOW */, IntPtr.Zero, null, ref startup, out process));
            if (!Native.AssignProcessToJobObject(job, process.Process))
            {
                var error = Marshal.GetLastWin32Error(); Native.TerminateProcess(process.Process, 1);
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
            for (;;)
            {
                Check(Native.QueryInformationJobObject(job, 1, out var accounting, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero));
                if (accounting.ActiveProcesses == 0) { break; }
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
        }
    }

    private static void Check(bool succeeded)
    {
        if (!succeeded) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
    }

    private static string Quote(string argument)
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
    private static class Native
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        public static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits limits, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CreateProcessW(string? application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string? directory, ref StartupInfo startup, out ProcessInformation process);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out Accounting accounting, uint size, IntPtr returned);
        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GetStdHandle(int kind);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access,
            [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
        [DllImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr handle);
    }
}
