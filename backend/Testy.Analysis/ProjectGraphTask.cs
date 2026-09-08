using System.Collections.Concurrent;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Build.Evaluation;
using Microsoft.Build.Execution;
using Microsoft.Build.Framework;
using Microsoft.Build.Graph;

namespace Testy.Analysis;

// Loaded by the selected SDK's MSBuild process, so SDK resolution and assembly
// binding use that SDK rather than a bundled copy of MSBuild.
public sealed class ProjectGraphTask : Microsoft.Build.Utilities.Task
{
    [Required] public string RequestFile { get; set; } = "";
    [Required] public string OutputFile { get; set; } = "";

    public override bool Execute()
    {
        try
        {
            using var request = JsonDocument.Parse(File.ReadAllText(RequestFile));
            var files = request.RootElement.TryGetProperty("files", out var entries)
                ? entries.Deserialize<string[]>()! : [request.RootElement.GetProperty("file").GetString()!];
            var configuration = request.RootElement.GetProperty("configuration").GetString()!;
            var concurrency = request.RootElement.TryGetProperty("concurrency", out var workers) ? Math.Max(1, workers.GetInt32()) : 1;
            var inputs = new ConcurrentDictionary<ProjectInstance, string[]>();
            using var collection = new ProjectCollection();
            var entryPoints = files.Select(file => new ProjectGraphEntryPoint(file, new Dictionary<string, string> { ["Configuration"] = configuration }));
            var graph = new ProjectGraph(entryPoints, collection, (projectFile, properties, projects) =>
            {
                var project = new Project(projectFile, properties, null, projects);
                var instance = project.CreateProjectInstance();
                inputs[instance] = project.Imports.Select(import => import.ImportedProject.FullPath)
                    .Concat(new[] { project.FullPath }).Distinct().ToArray();
                return instance;
            }, concurrency, CancellationToken.None);
            static IEnumerable<ProjectGraphNode> Targets(ProjectGraphNode node) => string.IsNullOrEmpty(node.ProjectInstance.GetPropertyValue("TargetFramework"))
                ? node.ProjectReferences.Where(child => child.ProjectInstance.FullPath == node.ProjectInstance.FullPath).SelectMany(Targets)
                : [node];
            static string Identity(ProjectGraphNode node)
            {
                var project = node.ProjectInstance;
                var file = OperatingSystem.IsWindows() ? project.FullPath.ToUpperInvariant() : project.FullPath;
                var properties = project.GlobalProperties.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                    .Select(pair => new[] { pair.Key.ToUpperInvariant(), pair.Value });
                var sdk = project.GetPropertyValue("MSBuildToolsPath");
                if (OperatingSystem.IsWindows()) { sdk = sdk.ToUpperInvariant(); }
                return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { file, properties, sdk }))));
            }
            var identities = graph.ProjectNodes.ToDictionary(node => node, Identity);
            var projects = graph.ProjectNodes.Where(node => !string.IsNullOrEmpty(node.ProjectInstance.GetPropertyValue("TargetFramework")))
                .Select(node =>
                {
                    var project = node.ProjectInstance;
                    string[] Items(string name) => project.GetItems(name).Select(item => item.GetMetadataValue("FullPath")).Where(value => value.Length > 0).Distinct().ToArray();
                    // The compiler discovers inherited editorconfig files after
                    // evaluation. Include absent candidates so creation and
                    // deletion are watched and versioned, including linked code.
                    var compilerConfigs = new HashSet<string>(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
                    foreach (var file in Items("Compile").Append(project.FullPath))
                    {
                        for (var directory = Path.GetDirectoryName(file); directory is not null; directory = Path.GetDirectoryName(directory))
                        {
                            if (!compilerConfigs.Add(Path.Combine(directory, ".editorconfig"))) { break; }
                        }
                    }
                    compilerConfigs.Add(Path.Combine(project.Directory, ".globalconfig"));
                    var ruleSet = project.GetPropertyValue("CodeAnalysisRuleSet");
                    if (!string.IsNullOrWhiteSpace(ruleSet)) { compilerConfigs.Add(Path.GetFullPath(ruleSet, project.Directory)); }
                    return new
                    {
                        file = project.FullPath,
                        framework = project.GetPropertyValue("TargetFramework"),
                        assembly = project.GetPropertyValue("TargetPath"),
                        assemblyName = project.GetPropertyValue("AssemblyName"),
                        outputDirectories = new[] { "TargetDir", "OutputPath", "IntermediateOutputPath", "BaseIntermediateOutputPath", "MSBuildProjectExtensionsPath" }
                            .Select(project.GetPropertyValue).Where(value => !string.IsNullOrWhiteSpace(value))
                            .Select(value => Path.GetFullPath(value, project.Directory))
                            .Append(Path.GetDirectoryName(project.GetPropertyValue("TargetPath")) ?? project.Directory).Distinct().ToArray(),
                        isTestProject = project.GetPropertyValue("IsTestProject").Equals("true", StringComparison.OrdinalIgnoreCase)
                            || project.GetPropertyValue("IsTestingPlatformApplication").Equals("true", StringComparison.OrdinalIgnoreCase),
                        isMtp = project.GetPropertyValue("IsTestingPlatformApplication").Equals("true", StringComparison.OrdinalIgnoreCase),
                        properties = project.GlobalProperties,
                        contextId = identities[node],
                        contextReferences = node.ProjectReferences.SelectMany(Targets).Select(reference => identities[reference]).Distinct().ToArray(),
                        sourceFiles = Items("Compile"),
                        inputs = inputs[project].Concat(Items("Content")).Concat(Items("None")).Concat(Items("EmbeddedResource"))
                            .Concat(Items("AdditionalFiles")).Concat(Items("EditorConfigFiles")).Concat(Items("GlobalAnalyzerConfigFiles"))
                            .Concat(Items("AnalyzerConfigFiles")).Concat(compilerConfigs)
                            .Where(input => !input.StartsWith(project.GetPropertyValue("MSBuildToolsPath") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)).Distinct().ToArray(),
                        references = node.ProjectReferences.Select(reference => reference.ProjectInstance.FullPath).Where(reference => reference != project.FullPath).Distinct().ToArray(),
                        binaryReferences = project.GetItems("Reference").Select(item => item.GetMetadataValue("HintPath"))
                            .Where(value => value.Length > 0).Select(value => Path.GetFullPath(value, project.Directory)).Distinct().ToArray()
                    };
                }).ToArray();
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
                return new
                {
                    file = Path.GetFullPath(file),
                    contexts = reachable.Where(node => !string.IsNullOrEmpty(node.ProjectInstance.GetPropertyValue("TargetFramework")))
                        .Select(node => identities[node]).Order().ToArray(),
                    entryPoints = entryNodes.SelectMany(Targets).Select(node => identities[node]).Distinct().Order().ToArray()
                };
            }).ToArray();
            File.WriteAllText(OutputFile, JsonSerializer.Serialize(new { projects, roots }));
            return true;
        }
        catch (Exception error)
        {
            Log.LogErrorFromException(error, showStackTrace: false);
            return false;
        }
    }
}
