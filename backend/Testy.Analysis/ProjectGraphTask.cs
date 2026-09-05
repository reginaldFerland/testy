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
            var file = request.RootElement.GetProperty("file").GetString()!;
            var configuration = request.RootElement.GetProperty("configuration").GetString()!;
            var inputs = new ConcurrentDictionary<ProjectInstance, string[]>();
            using var collection = new ProjectCollection();
            var entry = new ProjectGraphEntryPoint(file, new Dictionary<string, string> { ["Configuration"] = configuration });
            var graph = new ProjectGraph([entry], collection, (projectFile, properties, projects) =>
            {
                var project = new Project(projectFile, properties, null, projects);
                var instance = project.CreateProjectInstance();
                inputs[instance] = project.Imports.Select(import => import.ImportedProject.FullPath)
                    .Concat(new[] { project.FullPath }).Distinct().ToArray();
                return instance;
            });
            var roots = graph.EntryPointNodes.SelectMany(node => string.IsNullOrEmpty(node.ProjectInstance.GetPropertyValue("TargetFramework"))
                ? node.ProjectReferences.Where(child => child.ProjectInstance.FullPath == node.ProjectInstance.FullPath)
                : new[] { node }).ToHashSet();
            static IEnumerable<ProjectGraphNode> Targets(ProjectGraphNode node) => string.IsNullOrEmpty(node.ProjectInstance.GetPropertyValue("TargetFramework"))
                ? node.ProjectReferences.Where(child => child.ProjectInstance.FullPath == node.ProjectInstance.FullPath).SelectMany(Targets)
                : [node];
            static string Identity(ProjectGraphNode node)
            {
                var project = node.ProjectInstance;
                var file = OperatingSystem.IsWindows() ? project.FullPath.ToUpperInvariant() : project.FullPath;
                var properties = project.GlobalProperties.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                    .Select(pair => new[] { pair.Key.ToUpperInvariant(), pair.Value });
                return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { file, properties }))));
            }
            var result = graph.ProjectNodes.Where(node => !string.IsNullOrEmpty(node.ProjectInstance.GetPropertyValue("TargetFramework")))
                .Select(node =>
                {
                    var project = node.ProjectInstance;
                    string[] Items(string name) => project.GetItems(name).Select(item => item.GetMetadataValue("FullPath")).Where(value => value.Length > 0).Distinct().ToArray();
                    return new
                    {
                        file = project.FullPath,
                        framework = project.GetPropertyValue("TargetFramework"),
                        assembly = project.GetPropertyValue("TargetPath"),
                        isTestProject = project.GetPropertyValue("IsTestProject").Equals("true", StringComparison.OrdinalIgnoreCase)
                            || project.GetPropertyValue("IsTestingPlatformApplication").Equals("true", StringComparison.OrdinalIgnoreCase),
                        isMtp = project.GetPropertyValue("IsTestingPlatformApplication").Equals("true", StringComparison.OrdinalIgnoreCase),
                        entryPoint = roots.Contains(node),
                        properties = project.GlobalProperties,
                        contextId = Identity(node),
                        contextReferences = node.ProjectReferences.SelectMany(Targets).Select(Identity).Distinct().ToArray(),
                        sourceFiles = Items("Compile"),
                        inputs = inputs[project].Concat(Items("Content")).Concat(Items("None")).Concat(Items("EmbeddedResource"))
                            .Concat(Items("AdditionalFiles")).Where(input => !input.StartsWith(project.GetPropertyValue("MSBuildToolsPath") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)).Distinct().ToArray(),
                        references = node.ProjectReferences.Select(reference => reference.ProjectInstance.FullPath).Where(reference => reference != project.FullPath).Distinct().ToArray(),
                        binaryReferences = project.GetItems("Reference").Select(item => item.GetMetadataValue("HintPath"))
                            .Where(value => value.Length > 0).Select(value => Path.GetFullPath(value, project.Directory)).Distinct().ToArray()
                    };
                }).ToArray();
            File.WriteAllText(OutputFile, JsonSerializer.Serialize(result));
            return true;
        }
        catch (Exception error)
        {
            Log.LogErrorFromException(error, showStackTrace: false);
            return false;
        }
    }
}
