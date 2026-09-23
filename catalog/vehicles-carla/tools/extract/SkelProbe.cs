using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;
using CUE4Parse.UE4.Versions;
using Newtonsoft.Json;

namespace SimforgeCarlaExport;

// Dumps bone hierarchy (local ref pose, UE cm/Z-up) and sockets of skeletal meshes.
public static class SkelProbe
{
    public static void Run(string contentDir, string outFile, string targetsFile)
    {
        var targets = new HashSet<string>(File.ReadAllLines(targetsFile).Select(l => l.Trim()).Where(l => l.Length > 0), StringComparer.OrdinalIgnoreCase);
        var provider = new DefaultFileProvider(contentDir, SearchOption.AllDirectories, new VersionContainer(EGame.GAME_UE5_5));
        provider.Initialize();
        provider.PostMount();
        var result = new Dictionary<string, object>();
        foreach (var file in provider.Files.Values)
        {
            if (!file.Extension.Equals("uasset", StringComparison.OrdinalIgnoreCase)) continue;
            if (!targets.Contains(file.NameWithoutExtension)) continue;
            foreach (var export in provider.LoadPackage(file).GetExports())
            {
                if (export is not USkeletalMesh sk) continue;
                var rs = sk.ReferenceSkeleton;
                var bones = new List<object>();
                for (var i = 0; i < rs.FinalRefBoneInfo.Length; i++)
                {
                    var p = rs.FinalRefBonePose[i];
                    bones.Add(new { name = rs.FinalRefBoneInfo[i].Name.Text, parent = rs.FinalRefBoneInfo[i].ParentIndex,
                        t = new[] { p.Translation.X, p.Translation.Y, p.Translation.Z },
                        q = new[] { p.Rotation.X, p.Rotation.Y, p.Rotation.Z, p.Rotation.W },
                        s = new[] { p.Scale3D.X, p.Scale3D.Y, p.Scale3D.Z } });
                }
                var sockets = new List<object>();
                void AddSockets(IEnumerable<CUE4Parse.UE4.Objects.UObject.FPackageIndex> idxs, string origin)
                {
                    foreach (var idx in idxs ?? [])
                    {
                        if (idx == null || idx.IsNull || !idx.TryLoad(out var o)) continue;
                        sockets.Add(new { origin, name = o.GetOrDefault<CUE4Parse.UE4.Objects.UObject.FName>("SocketName").Text,
                            bone = o.GetOrDefault<CUE4Parse.UE4.Objects.UObject.FName>("BoneName").Text,
                            loc = o.GetOrDefault<CUE4Parse.UE4.Objects.Core.Math.FVector>("RelativeLocation"),
                            rot = o.GetOrDefault<CUE4Parse.UE4.Objects.Core.Math.FRotator>("RelativeRotation") });
                    }
                }
                AddSockets(sk.Sockets, "mesh");
                if (sk.Skeleton != null && sk.Skeleton.TryLoad(out USkeleton skel)) AddSockets(skel.Sockets, "skeleton");
                result[sk.Name] = new { package = file.Path, bones, sockets };
                Console.WriteLine($"{sk.Name}: {bones.Count} bones, {sockets.Count} sockets");
            }
        }
        File.WriteAllText(outFile, JsonConvert.SerializeObject(result, Formatting.Indented));
    }
}
