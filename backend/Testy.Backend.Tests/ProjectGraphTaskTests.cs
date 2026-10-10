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

    // Writes an SDK-less project; `body` is the content of its <Project> element.
    private string Project(string name, string body)
    {
        var path = Path.Combine(directory, name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, $"<Project>{body}<Target Name=\"Build\" /></Project>");
        return path;
    }

    private static string SingleTarget(string framework = "net10.0") => $"<PropertyGroup><TargetFramework>{framework}</TargetFramework></PropertyGroup>";

    // The inner build properties are what the SDK sets for TargetFrameworks; MSBuild's graph recognizes an outer build by them.
    private const string MultiTarget = "<PropertyGroup><InnerBuildProperty>TargetFramework</InnerBuildProperty><InnerBuildPropertyValues>InnerBuildProperties</InnerBuildPropertyValues>"
        + "<InnerBuildProperties>net8.0;net10.0</InnerBuildProperties></PropertyGroup>";

    private static string Reference(string project) => $"<ItemGroup><ProjectReference Include=\"{project}\" /></ItemGroup>";

    private JsonDocument Graph(params string[] files)
    {
        var request = Path.Combine(directory, "request.json");
        File.WriteAllText(request, JsonSerializer.Serialize(new { files, configuration = "Debug" }));
        var engine = new Engine();
        var task = new ProjectGraphTask { RequestFile = request, OutputFile = Path.Combine(directory, "graph.json"), BuildEngine = engine };
        Assert.True(task.Execute(), string.Join("\n", engine.Errors));
        return JsonDocument.Parse(File.ReadAllText(task.OutputFile));
    }

    private static JsonElement ProjectOf(JsonDocument graph, string file) =>
        graph.RootElement.GetProperty("projects").EnumerateArray().Single(project => project.GetProperty("file").GetString() == file);

    private static string[] Strings(JsonElement array) => [.. array.EnumerateArray().Select(item => item.GetString()!)];

    private static string[] Sorted(IEnumerable<string> values) => [.. values.Order(StringComparer.Ordinal)];

    [Fact]
    public void AMultiTargetedProjectIsRecordedOncePerFrameworkAndNotAsItsOuterBuild()
    {
        var project = Project("multi/multi.proj", MultiTarget);
        using var graph = Graph(project);
        var records = graph.RootElement.GetProperty("projects").EnumerateArray().ToArray();
        // The outer build (no TargetFramework) is evaluated but is not a project of its own.
        Assert.Equal(["net10.0", "net8.0"], records.Select(record => record.GetProperty("framework").GetString()!).Order(StringComparer.Ordinal));
        Assert.All(records, record => Assert.Equal(project, record.GetProperty("file").GetString()));
        var contexts = Sorted(records.Select(record => record.GetProperty("contextId").GetString()!));
        Assert.Equal(2, contexts.Distinct().Count());
        var root = graph.RootElement.GetProperty("roots").EnumerateArray().Single();
        Assert.Equal(contexts, Strings(root.GetProperty("contexts")));
        // The entry point stands for its inner builds, not for the outer build it named.
        Assert.Equal(contexts, Strings(root.GetProperty("entryPoints")));
        // Evaluations cover the outer build as well.
        Assert.Equal(3, graph.RootElement.GetProperty("evaluations").EnumerateObject().Count());
        Assert.Equal(3, Strings(root.GetProperty("evaluation")).Length);
        // The inner builds belong to the same project, so they are not references of each other.
        Assert.All(records, record => Assert.Empty(record.GetProperty("references").EnumerateArray()));
    }

    [Fact]
    public void ContextReferencesNameTheContextsOfTheReferencedProjects()
    {
        var library = Project("lib/lib.proj", SingleTarget());
        var app = Project("app/app.proj", SingleTarget() + Reference("../lib/lib.proj"));
        using var graph = Graph(app);
        var libraryContext = ProjectOf(graph, library).GetProperty("contextId").GetString();
        var record = ProjectOf(graph, app);
        Assert.Equal([libraryContext], Strings(record.GetProperty("contextReferences")));
        Assert.Equal([library], Strings(record.GetProperty("references")));
        Assert.Empty(ProjectOf(graph, library).GetProperty("contextReferences").EnumerateArray());
        Assert.NotEqual(libraryContext, record.GetProperty("contextId").GetString());
    }

    [Fact]
    public void AReferenceToAMultiTargetedProjectNamesItsInnerBuildsOnly()
    {
        var library = Project("lib/lib.proj", MultiTarget);
        var app = Project("app/app.proj", SingleTarget() + Reference("../lib/lib.proj"));
        using var graph = Graph(app);
        var inner = Sorted(graph.RootElement.GetProperty("projects").EnumerateArray()
            .Where(record => record.GetProperty("file").GetString() == library).Select(record => record.GetProperty("contextId").GetString()!));
        Assert.Equal(2, inner.Length);
        var references = Strings(ProjectOf(graph, app).GetProperty("contextReferences"));
        Assert.All(references, reference => Assert.Contains(reference, inner));
        Assert.NotEmpty(references);
        Assert.Equal(references, references.Distinct().Order(StringComparer.Ordinal));
    }

    [Fact]
    public void RootsCoverWhatTheyCanReachAndNothingElse()
    {
        var shared = Project("shared/shared.proj", SingleTarget());
        var app = Project("app/app.proj", SingleTarget() + Reference("../shared/shared.proj"));
        var tool = Project("tool/tool.proj", SingleTarget());
        using var graph = Graph(app, tool, shared);
        string Context(string file) => ProjectOf(graph, file).GetProperty("contextId").GetString()!;
        var roots = graph.RootElement.GetProperty("roots").EnumerateArray().ToDictionary(root => root.GetProperty("file").GetString()!);
        // In the order the files were requested.
        Assert.Equal([app, tool, shared], roots.Keys);
        Assert.Equal(Sorted([Context(app), Context(shared)]), Strings(roots[app].GetProperty("contexts")));
        Assert.Equal([Context(app)], Strings(roots[app].GetProperty("entryPoints")));
        Assert.Equal([Context(tool)], Strings(roots[tool].GetProperty("contexts")));
        // A project that another root also reaches is still a root of its own, reaching only itself.
        Assert.Equal([Context(shared)], Strings(roots[shared].GetProperty("contexts")));
        Assert.Equal([Context(shared)], Strings(roots[shared].GetProperty("entryPoints")));
        Assert.Equal(Sorted([Context(app), Context(shared)]), Strings(roots[app].GetProperty("evaluation")));
    }

    [Fact]
    public void ARepeatedEntryPointIsOneRoot()
    {
        var project = Project("a/a.proj", SingleTarget());
        using var graph = Graph(project, project);
        Assert.Single(graph.RootElement.GetProperty("roots").EnumerateArray());
    }

    [Fact]
    public void BinaryReferencesAreTheirHintPathsMadeAbsolute()
    {
        var project = Project("app/app.proj", SingleTarget() + """
            <ItemGroup>
              <Reference Include="Relative"><HintPath>..\libs\relative.dll</HintPath></Reference>
              <Reference Include="Absolute"><HintPath>$(MSBuildThisFileDirectory)absolute.dll</HintPath></Reference>
              <Reference Include="Duplicate"><HintPath>..\libs\relative.dll</HintPath></Reference>
              <Reference Include="System.Xml" />
            </ItemGroup>
            """);
        using var graph = Graph(project);
        // Backslashes are the project's authoring platform, not the current one; no hint means nothing to watch.
        Assert.Equal(Sorted([Path.Combine(directory, "libs", "relative.dll"), Path.Combine(directory, "app", "absolute.dll")]),
            Strings(ProjectOf(graph, project).GetProperty("binaryReferences")));
    }

    [Fact]
    public void TheGraphIsWrittenAtomically()
    {
        var (task, engine) = Task();
        File.WriteAllText(task.OutputFile, "previous");
        Assert.True(task.Execute(), string.Join("\n", engine.Errors));
        using (JsonDocument.Parse(File.ReadAllText(task.OutputFile))) { }
        Assert.Empty(Directory.GetFiles(directory, "*.tmp"));
    }

    [Fact]
    public void AGraphThatCannotBeWrittenLeavesNothingBehind()
    {
        var (task, engine) = Task();
        task.OutputFile = Path.Combine(directory, "missing", "graph.json");
        Assert.False(task.Execute());
        Assert.NotEmpty(engine.Errors);
        Assert.Empty(Directory.GetFiles(directory, "*.tmp", SearchOption.AllDirectories));
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
