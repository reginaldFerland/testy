using System.Collections.Concurrent;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Build.Evaluation;
using Microsoft.Build.Execution;
using Microsoft.Build.Framework;
using Microsoft.Build.Graph;
using Microsoft.Build.Definition;
using Microsoft.Build.Evaluation.Context;

namespace Testy.Analysis;

// Loaded by the selected SDK's MSBuild process, so SDK resolution and assembly
// binding use that SDK rather than a bundled copy of MSBuild.
[System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1001", Justification = "MSBuild may call Cancel at any time; a source without timers or a wait handle holds nothing to release.")]
public sealed class ProjectGraphTask : Microsoft.Build.Utilities.Task, ICancelableTask
{
    // MSBuild calls Cancel on Ctrl+C or when the build is aborted (the extension kills the process tree on cancellation).
    private readonly CancellationTokenSource cancellation = new();

    [Required] public string RequestFile { get; set; } = "";
    [Required] public string OutputFile { get; set; } = "";

    // MSBuild values keep the backslashes of the project's authoring platform.
    private static string FullPath(string value, string directory) => Path.GetFullPath(value.Replace('\\', Path.DirectorySeparatorChar), directory);

    // The hint, or else an Include that names a file ("libs\x.dll"; a bare "System.Xml" or a strong name is not one).
    private static string BinaryReference(string hint, string include)
    {
        if (hint.Length > 0) { return hint; }
        var file = include.Trim();
        return !file.Contains(',') && (file.IndexOfAny(['\\', '/']) >= 0 || file.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) || file.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) ? file : "";
    }

    public void Cancel() => cancellation.Cancel();

    public override bool Execute()
    {
        try
        {
            using var request = JsonDocument.Parse(File.ReadAllText(RequestFile));
            var files = request.RootElement.TryGetProperty("files", out var entries)
                ? entries.Deserialize(GraphJson.Default.StringArray)! : [request.RootElement.GetProperty("file").GetString()!];
            var configuration = request.RootElement.GetProperty("configuration").GetString()!;
            var concurrency = request.RootElement.TryGetProperty("concurrency", out var workers) ? Math.Clamp(workers.GetInt32(), 1, Environment.ProcessorCount) : 1;
            var inputs = new ConcurrentDictionary<ProjectInstance, string[]>();
            var evaluationInputs = new ConcurrentDictionary<ProjectInstance, EvaluationInputs.Snapshot>();
            var sharedInputs = new EvaluationInputs.Shared(request.RootElement.TryGetProperty("digestCache", out var digestCache) ? digestCache.GetString() : null);
            using var collection = new ProjectCollection();
            var entryPoints = files.Select(file => new ProjectGraphEntryPoint(file, new Dictionary<string, string> { ["Configuration"] = configuration }));
            var graph = new ProjectGraph(entryPoints, collection, (projectFile, properties, projects) =>
            {
                // Each project gets its own context because the file system facade
                // records the inputs of exactly one evaluation for reuse validation.
                // A context shared across projects would also share MSBuild's glob
                // expansion cache, hiding enumerations (for example a glob in a
                // common Directory.Build.props) from every later project's record.
                // Resolver state is fingerprinted once via sharedInputs, and parsed
                // import XML is still shared through the ProjectCollection.
                var fileSystem = new EvaluationInputs(sharedInputs);
                var project = Project.FromFile(projectFile, new ProjectOptions
                {
                    GlobalProperties = properties, ProjectCollection = projects,
                    EvaluationContext = EvaluationContext.Create(EvaluationContext.SharingPolicy.Shared, fileSystem)
                });
                var instance = project.CreateProjectInstance();
                try { evaluationInputs[instance] = fileSystem.Complete(project); }
                catch (Exception error) { evaluationInputs[instance] = new(false, [], new Dictionary<string, string>(), [], [], "", $"{error.GetType().Name}: {error.Message}"); }
                inputs[instance] = project.Imports.Select(import => import.ImportedProject.FullPath)
                    .Concat(new[] { project.FullPath }).Distinct().ToArray();
                // The graph only needs the immutable instance. Unloading keeps the
                // collection from retaining every evaluated Project for the task's
                // lifetime; parsed import XML stays cached for other projects.
                projects.UnloadProject(project);
                return instance;
            }, concurrency, cancellation.Token);
            static IEnumerable<ProjectGraphNode> Targets(ProjectGraphNode node) => string.IsNullOrEmpty(node.ProjectInstance.GetPropertyValue("TargetFramework"))
                ? node.ProjectReferences.Where(child => child.ProjectInstance.FullPath == node.ProjectInstance.FullPath).SelectMany(Targets)
                : [node];
            static string Identity(ProjectGraphNode node)
            {
                var project = node.ProjectInstance;
                var file = OperatingSystem.IsWindows() ? project.FullPath.ToUpperInvariant() : project.FullPath;
                var properties = project.GlobalProperties.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                    .Select(pair => new[] { pair.Key.ToUpperInvariant(), pair.Value }).ToArray();
                var sdk = project.GetPropertyValue("MSBuildToolsPath");
                if (OperatingSystem.IsWindows()) { sdk = sdk.ToUpperInvariant(); }
                return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new ContextIdentity(file, properties, sdk), GraphJson.Default.ContextIdentity))));
            }
            var identities = graph.ProjectNodes.ToDictionary(node => node, Identity);
            var projects = graph.ProjectNodes.Where(node => !string.IsNullOrEmpty(node.ProjectInstance.GetPropertyValue("TargetFramework")))
                .Select(node =>
                {
                    var project = node.ProjectInstance;
                    string[] Items(string name) => project.GetItems(name).Select(item => item.GetMetadataValue("FullPath")).Where(value => value.Length > 0).Distinct().ToArray();
                    var compile = Items("Compile");
                    var toolsPath = project.GetPropertyValue("MSBuildToolsPath");
                    var sdkPrefix = toolsPath + Path.DirectorySeparatorChar;
                    // The compiler discovers inherited editorconfig files after
                    // evaluation. Include absent candidates so creation and
                    // deletion are watched and versioned, including linked code.
                    var compilerConfigs = new HashSet<string>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
                    foreach (var file in compile.Append(project.FullPath))
                    {
                        for (var directory = Path.GetDirectoryName(file); directory is not null; directory = Path.GetDirectoryName(directory))
                        {
                            if (!compilerConfigs.Add(Path.Combine(directory, ".editorconfig"))) { break; }
                        }
                    }
                    compilerConfigs.Add(Path.Combine(project.Directory, ".globalconfig"));
                    var ruleSet = project.GetPropertyValue("CodeAnalysisRuleSet");
                    if (!string.IsNullOrWhiteSpace(ruleSet)) { compilerConfigs.Add(FullPath(ruleSet, project.Directory)); }
                    // Analyzers and generators listed in the project run inside the compiler, so changing one changes the build.
                    // Those the SDK, its packs or the NuGet cache supply are versioned by the SDK or by restore (project.assets.json).
                    var packageRoot = project.GetPropertyValue("NuGetPackageRoot");
                    var shipped = new List<string> { sdkPrefix };
                    if (toolsPath.Length > 0 && Path.GetDirectoryName(Path.GetDirectoryName(toolsPath)) is { } dotnetRoot) { shipped.Add(Path.Combine(dotnetRoot, "packs") + Path.DirectorySeparatorChar); }
                    if (!string.IsNullOrWhiteSpace(packageRoot)) { shipped.Add(Path.TrimEndingDirectorySeparator(FullPath(packageRoot, project.Directory)) + Path.DirectorySeparatorChar); }
                    var analyzers = Items("Analyzer").Where(analyzer => !shipped.Any(prefix => analyzer.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))).ToArray();
                    var inputFiles = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var group in new IEnumerable<string>[] { inputs[project], Items("Content"), Items("None"), Items("EmbeddedResource"), Items("AdditionalFiles"),
                        Items("EditorConfigFiles"), Items("GlobalAnalyzerConfigFiles"), Items("AnalyzerConfigFiles"), compilerConfigs })
                    {
                        inputFiles.UnionWith(group.Where(input => !input.StartsWith(sdkPrefix, StringComparison.OrdinalIgnoreCase)));
                    }
                    inputFiles.UnionWith(analyzers);
                    return new ProjectRecord(
                        File: project.FullPath,
                        Framework: project.GetPropertyValue("TargetFramework"),
                        Assembly: project.GetPropertyValue("TargetPath"),
                        AssemblyName: project.GetPropertyValue("AssemblyName"),
                        OutputDirectories: EvaluationInputs.OutputProperties
                            .Select(project.GetPropertyValue).Where(value => !string.IsNullOrWhiteSpace(value))
                            .Select(value => Path.TrimEndingDirectorySeparator(FullPath(value, project.Directory)))
                            .Append(Path.GetDirectoryName(project.GetPropertyValue("TargetPath")) ?? project.Directory).Distinct().Order(StringComparer.Ordinal).ToArray(),
                        IsTestProject: project.GetPropertyValue("IsTestProject").Equals("true", StringComparison.OrdinalIgnoreCase)
                            || project.GetPropertyValue("IsTestingPlatformApplication").Equals("true", StringComparison.OrdinalIgnoreCase),
                        IsMtp: project.GetPropertyValue("IsTestingPlatformApplication").Equals("true", StringComparison.OrdinalIgnoreCase),
                        Properties: project.GlobalProperties,
                        ContextId: identities[node],
                        ContextReferences: node.ProjectReferences.SelectMany(Targets).Select(reference => identities[reference]).Distinct().Order(StringComparer.Ordinal).ToArray(),
                        SourceFiles: compile,
                        Inputs: [.. inputFiles.Order(StringComparer.Ordinal)],
                        References: node.ProjectReferences.Select(reference => reference.ProjectInstance.FullPath).Where(reference => reference != project.FullPath).Distinct().Order(StringComparer.Ordinal).ToArray(),
                        BinaryReferences: project.GetItems("Reference").Select(item => BinaryReference(item.GetMetadataValue("HintPath"), item.EvaluatedInclude))
                            .Where(value => value.Length > 0).Select(value => FullPath(value, project.Directory)).Distinct().Order(StringComparer.Ordinal).ToArray()
                    );
                }).OrderBy(project => project.ContextId, StringComparer.Ordinal).ToArray();
            var comparer = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
            var roots = files.Distinct(comparer).Select(file =>
            {
                var entryNodes = graph.EntryPointNodes.Where(node => comparer.Equals(node.ProjectInstance.FullPath, Path.GetFullPath(file))).ToArray();
                var pending = new Stack<ProjectGraphNode>(entryNodes);
                var reachable = new HashSet<ProjectGraphNode>();
                while (pending.TryPop(out var node))
                {
                    if (!reachable.Add(node)) { continue; }
                    foreach (var reference in node.ProjectReferences) { pending.Push(reference); }
                }
                return new RootRecord(
                    File: Path.GetFullPath(file),
                    Contexts: reachable.Where(node => !string.IsNullOrEmpty(node.ProjectInstance.GetPropertyValue("TargetFramework")))
                        .Select(node => identities[node]).Order(StringComparer.Ordinal).ToArray(),
                    EntryPoints: entryNodes.SelectMany(Targets).Select(node => identities[node]).Distinct().Order(StringComparer.Ordinal).ToArray(),
                    Evaluation: reachable.Select(node => identities[node]).Order(StringComparer.Ordinal).ToArray()
                );
            }).ToArray();
            var evaluations = graph.ProjectNodes.OrderBy(node => identities[node], StringComparer.Ordinal)
                .ToDictionary(node => identities[node], node => evaluationInputs[node.ProjectInstance]);
            // Written beside the output and renamed into place, so a reader never sees a partial graph.
            // A process killed between the write and the rename leaves its file behind; clear the old ones.
            StaleTemporaryFiles.Delete(Path.GetDirectoryName(Path.GetFullPath(OutputFile))!, Path.GetFileName(OutputFile) + ".*.tmp");
            var temporary = $"{OutputFile}.{Guid.NewGuid():N}.tmp";
            try
            {
                File.WriteAllText(temporary, JsonSerializer.Serialize(new ProjectGraphOutput(ProjectGraphOutput.Current, projects, roots, evaluations), GraphJson.Default.ProjectGraphOutput));
                File.Move(temporary, OutputFile, overwrite: true);
            }
            catch
            {
                try { File.Delete(temporary); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                throw;
            }
            return true;
        }
        // Not only OperationCanceledException: ProjectGraph can stop loading part-way and then fail
        // looking up the nodes it skipped. Once cancelled, any failure is the cancellation.
        catch (Exception) when (cancellation.IsCancellationRequested)
        {
            Log.LogError("The project graph evaluation was cancelled.");
            return false;
        }
        catch (Exception error)
        {
            Log.LogErrorFromException(error, showStackTrace: true);
            return false;
        }
    }
}
