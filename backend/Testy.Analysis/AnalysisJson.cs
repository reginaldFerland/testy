using System.Text.Json.Serialization;

namespace Testy.Analysis;

// Every JSON document this assembly writes for the TypeScript side. Member names are the
// wire contract (camelCase), declared once here instead of by reflection over anonymous
// types, so a renamed member cannot silently change them (see JsonContractTests).
//
// Two contexts, because the source analysis server runs without MSBuild: a context
// resolves every one of its types when it first serializes anything, and
// EvaluationInputs cannot be loaded without Microsoft.Build.
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(string[]))]
[JsonSerializable(typeof(Dictionary<string, SourceShape?>))]
[JsonSerializable(typeof(CombinedAnalysis))]
[JsonSerializable(typeof(SourceAnalysisProvenance))]
[JsonSerializable(typeof(Dictionary<string, SourceLocations.Location?>))]
internal sealed partial class AnalysisJson : JsonSerializerContext;

// What the project graph task, which MSBuild loads, writes and reads.
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ProjectGraphOutput))]
[JsonSerializable(typeof(ContextIdentity))]
[JsonSerializable(typeof(EvaluationInputs.Snapshot))]
[JsonSerializable(typeof(DigestStore.Contents))]
internal sealed partial class GraphJson : JsonSerializerContext;

sealed record CombinedAnalysis(string[] Aliases, Dictionary<string, SourceShape?> Analyses);
sealed record SourceAnalysisProvenance(int Version, string RequestHash, string[] Aliases, Dictionary<string, SourceShape?> Analyses, Dictionary<string, string?> SourceHashes);

// Bump Version when a field of the project graph is removed or changes meaning; the reader rejects other versions.
sealed record ProjectGraphOutput(int Version, ProjectRecord[] Projects, RootRecord[] Roots, Dictionary<string, EvaluationInputs.Snapshot> Evaluations)
{
    public const int Current = 1;
}

sealed record ProjectRecord(string File, string Framework, string Assembly, string AssemblyName, string[] OutputDirectories, bool IsTestProject, bool IsMtp,
    IDictionary<string, string> Properties, string ContextId, string[] ContextReferences, string[] SourceFiles, string[] Inputs, string[] References, string[] BinaryReferences);

sealed record RootRecord(string File, string[] Contexts, string[] EntryPoints, string[] Evaluation);

// The text hashed into a project context's identity.
sealed record ContextIdentity(string File, string[][] Properties, string Sdk);
