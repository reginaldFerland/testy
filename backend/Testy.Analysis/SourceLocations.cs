using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

static class SourceLocations
{
    public record Location(string File, int Line);

    // Use compiled metadata and portable symbols when the provider omits source
    // locations. Overloads spanning multiple files remain deliberately unknown.
    public static Dictionary<string, Location?> Read(string assembly)
    {
        using var stream = File.OpenRead(assembly);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        using var symbols = MetadataReaderProvider.FromPortablePdbStream(File.OpenRead(Path.ChangeExtension(assembly, ".pdb")));
        var pdb = symbols.GetMetadataReader();
        var result = new Dictionary<string, Location?>();
        foreach (var handle in metadata.MethodDefinitions)
        {
            var method = metadata.GetMethodDefinition(handle);
            var debug = pdb.GetMethodDebugInformation(handle.ToDebugInformationHandle());
            var points = debug.GetSequencePoints().Where(point => !point.IsHidden).ToArray();
            if (points.Length == 0) {continue;}
            var point = points[0];
            var document = point.Document.IsNil ? debug.Document : point.Document;
            if (document.IsNil) {continue;}
            var kickoff = debug.GetStateMachineKickoffMethod();
            if (!kickoff.IsNil) {method = metadata.GetMethodDefinition(kickoff);}
            var type = TypeName(metadata, method.GetDeclaringType());
            var key = type + "." + metadata.GetString(method.Name);
            var location = new Location(pdb.GetString(pdb.GetDocument(document).Name), point.StartLine);
            if (result.TryGetValue(key, out var previous) && previous?.File != location.File) {result[key] = null;}
            else if (!result.ContainsKey(key)) {result[key] = location;}
        }
        return result;
    }

    static string TypeName(MetadataReader metadata, TypeDefinitionHandle handle)
    {
        var type = metadata.GetTypeDefinition(handle);
        var declaring = type.GetDeclaringType();
        var name = metadata.GetString(type.Name);
        if (!declaring.IsNil) {return TypeName(metadata, declaring) + "+" + name;}
        var ns = metadata.GetString(type.Namespace);
        return string.IsNullOrEmpty(ns) ? name : ns + "." + name;
    }
}
