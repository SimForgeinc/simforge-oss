using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion.Animations;
using Newtonsoft.Json;

namespace SimforgeCarlaExport;

public static class AnimationExport
{
    public static void Run(string contentDir, string outDir)
    {
        var provider = new DefaultFileProvider(contentDir, SearchOption.AllDirectories,
            new VersionContainer(EGame.GAME_UE5_5));
        provider.Initialize();
        var engine = new DefaultFileProvider(Path.Combine(Path.GetDirectoryName(contentDir)!, "Engine"),
            SearchOption.AllDirectories, new VersionContainer(EGame.GAME_UE5_5));
        engine.Initialize();
        provider.Files.AddFiles(engine.Files.Values.ToDictionary(f => f.Path, f => f));
        provider.PostMount();
        Directory.CreateDirectory(outDir);
        var inventory = new List<object>();
        foreach (var file in provider.Files.Values.OrderBy(f => f.Path))
        {
            if (file.Extension != "uasset" || !file.Path.Contains("/Animations/")) continue;
            foreach (var asset in provider.LoadPackage(file).GetExports().OfType<UAnimSequence>())
            {
                var skeleton = asset.Skeleton.Load<USkeleton>();
                var sequence = asset.ConvertAnims().Sequences.Single();
                var bones = skeleton.ReferenceSkeleton.FinalRefBoneInfo;
                var tracks = new List<object>();
                for (var b = 0; b < bones.Length; b++)
                {
                    var pose = skeleton.ReferenceSkeleton.FinalRefBonePose[b];
                    var samples = new List<object>();
                    for (var frame = 0; frame < sequence.NumFrames; frame++)
                    {
                        var q = pose.Rotation;
                        var p = pose.Translation;
                        var s = pose.Scale3D;
                        sequence.Tracks[b].GetBoneTransform(frame, sequence.NumFrames, ref q, ref p, ref s);
                        samples.Add(new { translation = new[] { p.X, p.Z, p.Y }.Select(v => v * 0.01f),
                            rotation = new[] { q.X, q.Z, q.Y, -q.W }, scale = new[] { s.X, s.Z, s.Y } });
                    }
                    tracks.Add(new { name = bones[b].Name.Text, parent = bones[b].ParentIndex,
                        retargetMode = skeleton.BoneTree[b].ToString(),
                        referenceTranslation = new[] { pose.Translation.X * 0.01f, pose.Translation.Z * 0.01f, pose.Translation.Y * 0.01f },
                        samples });
                }
                var entry = new { name = asset.Name, source = file.Path, skeleton = skeleton.Name,
                    duration = asset.SequenceLength, frames = sequence.NumFrames,
                    frameRate = (sequence.NumFrames - 1) / asset.SequenceLength,
                    additive = sequence.IsAdditive, tracks };
                File.WriteAllText(Path.Combine(outDir, asset.Name + ".json"), JsonConvert.SerializeObject(entry));
                inventory.Add(new { entry.name, entry.source, entry.skeleton, entry.duration, entry.frames, entry.frameRate, entry.additive });
                Console.WriteLine($"Decoded {asset.Name}: {sequence.NumFrames} frames, {asset.SequenceLength}s, {skeleton.Name}");
            }
        }
        File.WriteAllText(Path.Combine(outDir, "inventory.json"), JsonConvert.SerializeObject(inventory, Formatting.Indented));
    }
}
