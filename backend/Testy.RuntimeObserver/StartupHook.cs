using System.Reflection;
using System.Text;

// The runtime invokes this before Main, in test hosts and their managed children.
// Use only framework primitives: loading a serializer here could change which
// version of that dependency the application itself resolves.
internal static class StartupHook
{
    // The gate is re-entrant: an assembly loaded while this thread is writing
    // (for example by the encoder) would re-enter the StreamWriter mid-line.
    // Defer such loads and record them after the outer write completes.
    [ThreadStatic] private static List<Assembly>? deferred;

    public static void Initialize()
    {
        try
        {
            var manifest = Environment.GetEnvironmentVariable("TESTY_RUNTIME_OBSERVATION");
            if (string.IsNullOrEmpty(manifest)) { return; }
            var lines = File.ReadAllLines(manifest);
            var directory = Decode(lines[0]);
            var host = Decode(lines[1]);
            var names = new HashSet<string>(lines.Skip(2).Select(Decode), StringComparer.OrdinalIgnoreCase);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var gate = new object();
            var failed = false;
            var entry = Assembly.GetEntryAssembly()?.Location ?? "";
            var log = new FileStream(Path.Combine(directory, $"{Guid.NewGuid()}.log"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
            StreamWriter writer;
            try
            {
                writer = new StreamWriter(log) { AutoFlush = true };
                writer.WriteLine("ready\t" + Encode(entry));
            }
            catch
            {
                // The handle would otherwise stay open (and the file locked) for the life of the process.
                log.Dispose();
                throw;
            }
            // The set is complete before the first handler runs and is never written afterwards,
            // so unlisted loads (nearly all of them) are dismissed without taking the gate.
            bool Listed(Assembly assembly)
            {
                // The simple name is the full name up to its first comma; AssemblyName would allocate for every load.
                try { var full = assembly.FullName ?? ""; var comma = full.IndexOf(','); return names.Contains(comma < 0 ? full : full[..comma]); }
                catch { failed = true; return false; }
            }
            void Loaded(Assembly assembly)
            {
                if (!Listed(assembly)) { return; }
                if (deferred is not null) { deferred.Add(assembly); return; }
                lock (gate)
                {
                    deferred = [];
                    try
                    {
                        for (var pending = new Queue<Assembly>([assembly]); pending.Count > 0;)
                        {
                            Record(pending.Dequeue());
                            foreach (var later in deferred) { pending.Enqueue(later); }
                            deferred.Clear();
                        }
                    }
                    finally { deferred = null; }
                }
            }
            void Record(Assembly assembly)
            {
                try
                {
                    var name = assembly.GetName().Name ?? "";
                    if (!names.Contains(name)) { return; }
                    var location = assembly.IsDynamic ? "" : assembly.Location;
                    if (seen.Add(name + "\0" + location)) { writer.WriteLine("module\t" + Encode(name) + "\t" + Encode(location)); }
                }
                catch { failed = true; }
            }
            AppDomain.CurrentDomain.AssemblyLoad += (_, args) =>
            {
                // A handler that throws would crash the observed process.
                try { Loaded(args.LoadedAssembly); }
                catch { failed = true; }
            };
            // ProcessExit does not run when the process is killed or crashes. The
            // missing "complete" record is then the signal, so nothing else is
            // flushed or finalized on abnormal exit (lines are flushed as written).
            AppDomain.CurrentDomain.ProcessExit += (_, _) =>
            {
                lock (gate)
                {
                    deferred = [];
                    try { writer.WriteLine("complete\t" + (failed ? "false" : "true")); }
                    catch { /* A missing completion record makes selection conservative. */ }
                    finally { deferred = null; }
                }
            };
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) { Loaded(assembly); }
            if (IsSamePath(entry, host)) { Detach(); }
        }
        catch { /* Observation must never prevent the application from running. */ }
    }

    // Applications started by the observed host (MSBuild nodes, compiler servers)
    // are not observed and must not inherit the hook. A process that only launches
    // the host, such as a coverage collector, keeps it so the host still receives it.
    private static void Detach()
    {
        try
        {
            Environment.SetEnvironmentVariable("TESTY_RUNTIME_OBSERVATION", null);
            var self = typeof(StartupHook).Assembly.Location;
            var remaining = (Environment.GetEnvironmentVariable("DOTNET_STARTUP_HOOKS") ?? "")
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
                .Where(hook => !IsSamePath(hook, self)).ToArray();
            Environment.SetEnvironmentVariable("DOTNET_STARTUP_HOOKS", remaining.Length == 0 ? null : string.Join(Path.PathSeparator, remaining));
        }
        catch { /* The extension tolerates incomplete reports from other processes. */ }
    }

    private static bool IsSamePath(string left, string right)
    {
        try
        {
            return left.Length > 0 && right.Length > 0 && string.Equals(Path.GetFullPath(left), Path.GetFullPath(right),
                OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
        }
        catch { return false; }
    }

    private static string Encode(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
    private static string Decode(string value) => Encoding.UTF8.GetString(Convert.FromBase64String(value));
}
