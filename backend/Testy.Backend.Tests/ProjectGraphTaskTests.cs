using System.Collections;
using System.Text.Json;
using Microsoft.Build.Framework;
using Testy.Analysis;
using Xunit;

namespace Testy.Backend.Tests;

// The task runs inside the user's MSBuild, which calls ICancelableTask.Cancel when the build
// is aborted. A project without an SDK evaluates in-process, so no .NET SDK is resolved here.
public sealed class ProjectGraphTaskTests : IDisposable
{
    private readonly string directory = Directory.CreateTempSubdirectory("testy-graph-").FullName;

    public void Dispose() => Directory.Delete(directory, recursive: true);

    private (ProjectGraphTask Task, Engine Engine) Task()
    {
        var project = Path.Combine(directory, "a.proj");
        File.WriteAllText(project, "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><Target Name=\"Build\" /></Project>");
        var request = Path.Combine(directory, "request.json");
        File.WriteAllText(request, JsonSerializer.Serialize(new { files = new[] { project }, configuration = "Debug" }));
        var engine = new Engine();
        return (new ProjectGraphTask { RequestFile = request, OutputFile = Path.Combine(directory, "graph.json"), BuildEngine = engine }, engine);
    }

    [Fact]
    public void EvaluatesTheGraph()
    {
        var (task, engine) = Task();
        Assert.True(task.Execute(), string.Join("\n", engine.Errors));
        using var graph = JsonDocument.Parse(File.ReadAllText(task.OutputFile));
        Assert.Equal(Path.Combine(directory, "a.proj"), graph.RootElement.GetProperty("projects")[0].GetProperty("file").GetString());
        // The TypeScript reader rejects any other version, and the members it reads keep their names.
        Assert.Equal(["version", "projects", "roots", "evaluations"], graph.RootElement.EnumerateObject().Select(property => property.Name));
        Assert.Equal(1, graph.RootElement.GetProperty("version").GetInt32());
        Assert.Equal(["file", "framework", "assembly", "assemblyName", "outputDirectories", "isTestProject", "isMtp", "properties", "contextId", "contextReferences",
            "sourceFiles", "inputs", "references", "binaryReferences"], graph.RootElement.GetProperty("projects")[0].EnumerateObject().Select(property => property.Name));
        Assert.Equal(["file", "contexts", "entryPoints", "evaluation"], graph.RootElement.GetProperty("roots")[0].EnumerateObject().Select(property => property.Name));
    }

    [Fact]
    public void ACancelledTaskFailsWithoutWritingAGraph()
    {
        var (task, engine) = Task();
        Assert.IsAssignableFrom<ICancelableTask>(task);
        task.Cancel();
        Assert.False(task.Execute());
        Assert.Equal(["The project graph evaluation was cancelled."], engine.Errors);
        Assert.False(File.Exists(task.OutputFile));
    }

    private sealed class Engine : IBuildEngine
    {
        public List<string> Errors { get; } = [];
        public bool ContinueOnError => false;
        public int LineNumberOfTaskNode => 0;
        public int ColumnNumberOfTaskNode => 0;
        public string ProjectFileOfTaskNode => "";
        public bool BuildProjectFile(string projectFileName, string[] targetNames, IDictionary globalProperties, IDictionary targetOutputs) => false;
        public void LogCustomEvent(CustomBuildEventArgs e) { }
        public void LogErrorEvent(BuildErrorEventArgs e) => Errors.Add(e.Message ?? "");
        public void LogMessageEvent(BuildMessageEventArgs e) { }
        public void LogWarningEvent(BuildWarningEventArgs e) { }
    }
}
