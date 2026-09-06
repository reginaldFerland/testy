using System.Reflection;
using System.Text;

// The runtime invokes this before Main, in test hosts and their managed children.
// Use only framework primitives: loading a serializer here could change which
// version of that dependency the application itself resolves.
internal static class StartupHook
{
    public static void Initialize()
    {
        try
        {
            var manifest = Environment.GetEnvironmentVariable("TESTY_RUNTIME_OBSERVATION");
            if (string.IsNullOrEmpty(manifest)) { return; }
            var lines = File.ReadAllLines(manifest);
            var directory = Decode(lines[0]);
            var names = new HashSet<string>(lines.Skip(1).Select(Decode), StringComparer.OrdinalIgnoreCase);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var gate = new object();
            var failed = false;
            var writer = new StreamWriter(new FileStream(Path.Combine(directory, $"{Guid.NewGuid()}.log"),
                FileMode.CreateNew, FileAccess.Write, FileShare.Read)) { AutoFlush = true };
            writer.WriteLine("ready\t" + Encode(Assembly.GetEntryAssembly()?.Location ?? ""));
            void Loaded(Assembly assembly)
            {
                lock (gate)
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
            }
            AppDomain.CurrentDomain.AssemblyLoad += (_, args) => Loaded(args.LoadedAssembly);
            AppDomain.CurrentDomain.ProcessExit += (_, _) =>
            {
                lock (gate)
                {
                    try { writer.WriteLine("complete\t" + (failed ? "false" : "true")); }
                    catch { /* A missing completion record makes selection conservative. */ }
                }
            };
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) { Loaded(assembly); }
        }
        catch { /* Observation must never prevent the application from running. */ }
    }

    private static string Encode(string value) => Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
    private static string Decode(string value) => Encoding.UTF8.GetString(Convert.FromBase64String(value));
}
