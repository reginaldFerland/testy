using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Loader;

namespace Testy.Analysis;

// Roslyn is not shipped with the extension. It is loaded from the .NET SDK that
// is installed beside the runtime running this helper, where every SDK keeps it
// (<root>/sdk/<version>/Roslyn/bincore, precompiled for fast start-up). This
// assembly is compiled against Roslyn 5.0, the version SDK 10.0.100 ships, so any
// later 5.x binds to it as MSBuild 18.0 binds to later MSBuilds.
// Register must run before any code touching Roslyn is compiled (see Program).
static class RoslynLoader
{
    static readonly string[] Names = ["Microsoft.CodeAnalysis", "Microsoft.CodeAnalysis.CSharp"];
    static readonly byte[] PublicKeyToken = Convert.FromHexString("31bf3856ad364e35");
    static readonly object Gate = new();
    static string? chosen;

    public static void Register() => AssemblyLoadContext.Default.Resolving += Resolve;

    // Set once Roslyn is resolved, for diagnostics.
    public static string? Location => chosen;

    // Why Roslyn could not be found. The runtime reports a failed load without
    // the reasons the handler had, so callers print this beside the exception.
    public static string? Failure { get; private set; }

    static Assembly? Resolve(AssemblyLoadContext context, AssemblyName requested)
    {
        if (requested.Name is null || Array.IndexOf(Names, requested.Name) < 0) { return null; }
        try { return context.LoadFromAssemblyPath(Path.Combine(Locate(requested.Version ?? new Version(0, 0)), requested.Name + ".dll")); }
        catch (FileNotFoundException error) { Failure = error.Message; return null; }
    }

    static string Locate(Version minimum)
    {
        lock (Gate)
        {
            if (chosen is not null) { return chosen; }
            var problems = new List<string>();
            var configured = Environment.GetEnvironmentVariable("TESTY_ROSLYN_DIR");
            if (!string.IsNullOrEmpty(configured))
            {
                // An explicit directory is for diagnostics and tests; it is not searched around.
                return chosen = Inspect(Path.GetFullPath(configured), minimum, problems)?.Directory
                    ?? throw Unavailable(minimum, problems);
            }
            foreach (var root in Roots())
            {
                var sdks = Path.Combine(root, "sdk");
                if (!System.IO.Directory.Exists(sdks)) { continue; }
                var candidates = new List<Candidate>();
                foreach (var sdk in System.IO.Directory.EnumerateDirectories(sdks))
                {
                    if (Inspect(Path.Combine(sdk, "Roslyn", "bincore"), minimum, problems) is { } candidate) { candidates.Add(candidate with { Sdk = Path.GetFileName(sdk) }); }
                }
                if (Best(candidates, minimum) is { } best) { return chosen = best.Directory; }
            }
            throw Unavailable(minimum, problems);
        }
    }

    // The runtime that started this process is the best witness of the installation
    // that `dotnet` selected, including when `dotnet` was a wrapper or a symlink.
    static IEnumerable<string> Roots()
    {
        var seen = new HashSet<string>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        var runtime = Path.TrimEndingDirectorySeparator(RuntimeEnvironment.GetRuntimeDirectory());
        var origins = new List<string?>
        {
            // <root>/shared/Microsoft.NETCore.App/<version>
            Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(runtime))),
            Path.GetDirectoryName(Environment.ProcessPath),
            Environment.GetEnvironmentVariable("DOTNET_ROOT"),
            Environment.GetEnvironmentVariable("DOTNET_ROOT(x86)")
        };
        foreach (var origin in origins)
        {
            if (!string.IsNullOrEmpty(origin) && seen.Add(Path.GetFullPath(origin))) { yield return Path.GetFullPath(origin); }
        }
    }

    internal sealed record Candidate(string Directory, Version Roslyn, string Sdk = "");

    // The SDK line this helper was built against first, stable before preview,
    // then the newest Roslyn, then the newest SDK.
    internal static Candidate? Best(IEnumerable<Candidate> candidates, Version minimum) => candidates
        .OrderByDescending(candidate => candidate.Roslyn.Major == minimum.Major)
        .ThenByDescending(candidate => !candidate.Sdk.Contains('-'))
        .ThenByDescending(candidate => candidate.Roslyn)
        .ThenByDescending(candidate => SdkVersion(candidate.Sdk))
        .ThenByDescending(candidate => candidate.Sdk, StringComparer.Ordinal)
        .FirstOrDefault();

    internal static Candidate? Inspect(string directory, Version minimum, List<string> problems)
    {
        try
        {
            var common = AssemblyName.GetAssemblyName(Path.Combine(directory, "Microsoft.CodeAnalysis.dll"));
            var csharp = AssemblyName.GetAssemblyName(Path.Combine(directory, "Microsoft.CodeAnalysis.CSharp.dll"));
            if (common.Version is null || csharp.Version != common.Version) { problems.Add($"{directory}: mismatched Roslyn assemblies"); return null; }
            if (common.Version < minimum) { problems.Add($"{directory}: Roslyn {common.Version} is older than {minimum}"); return null; }
            foreach (var name in new[] { common, csharp })
            {
                if (!(name.GetPublicKeyToken() ?? []).AsSpan().SequenceEqual(PublicKeyToken)) { problems.Add($"{directory}: {name.Name} is not signed by Microsoft"); return null; }
            }
            return new Candidate(directory, common.Version);
        }
        catch (Exception error) when (error is IOException or BadImageFormatException or UnauthorizedAccessException)
        {
            problems.Add($"{directory}: {error.Message}");
            return null;
        }
    }

    static Version SdkVersion(string name) => Version.TryParse(name.Split('-')[0], out var version) ? version : new Version(0, 0);

    static FileNotFoundException Unavailable(Version minimum, List<string> problems) =>
        new($"Roslyn {minimum} or newer was not found in the .NET SDK installed beside {RuntimeEnvironment.GetRuntimeDirectory()}."
            + (problems.Count == 0 ? "" : " " + string.Join("; ", problems)));
}
