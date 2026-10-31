#if UNITY_EDITOR
using System;
using System.IO;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using GameAssetFactory.Maps;

namespace GameAssetFactory.Editor
{
    public static class FactoryMapImporter
    {
        [MenuItem("Tools/生产工厂/导入 2D 地图")]
        public static void Open()
        {
            var file = EditorUtility.OpenFilePanel("选择解压资源包中的 map.json", "", "json");
            if (string.IsNullOrEmpty(file)) return;
            try { Selection.activeObject = Import(file); }
            catch (Exception error) { Debug.LogException(error); EditorUtility.DisplayDialog("地图导入失败", error.Message, "确定"); }
        }
        public static GameObject Import(string file)
        {
            ValidateRuntimeAssembly(typeof(FactoryMapRoot));
            ValidateRuntimeAssembly(typeof(FactoryMapSort));
            ValidateRuntimeAssembly(typeof(FactoryMapZone));
            var doc = JsonUtility.FromJson<MapDocument>(File.ReadAllText(file));
            if (doc == null || doc.format != "game-asset-factory-map" || doc.version != 2 || doc.images == null || doc.pixelsPerUnit <= 0)
                throw new InvalidDataException("地图格式或版本不受支持。");
            var source = Path.GetFullPath(Path.GetDirectoryName(file)) + Path.DirectorySeparatorChar;
            var safe = string.Join("_", (doc.name ?? "Map").Split(Path.GetInvalidFileNameChars())).Replace('/', '_').Replace('\\', '_');
            if (string.IsNullOrWhiteSpace(safe)) safe = "Map";
            var directory = "Assets/GeneratedMaps/" + safe;
            Directory.CreateDirectory(directory + "/Textures");
            var root = new GameObject(safe);
            try
            {
                var map = root.AddComponent<FactoryMapRoot>();
                if (map == null) throw new InvalidOperationException("无法添加地图运行时组件。请将 Unity 文件夹移到 Assets/Unity，确保 Runtime 不在任何 Editor 目录下；等待重新编译后再导入。");
                map.pixelsPerUnit = doc.pixelsPerUnit; map.originY = doc.originY; map.height = doc.height;
                var shader = Shader.Find("Universal Render Pipeline/2D/Sprite-Unlit-Default") ?? Shader.Find("Sprites/Default");
                Material material = null;
                if (shader != null)
                {
                    var materialPath = directory + "/MapSprites.mat";
                    material = AssetDatabase.LoadAssetAtPath<Material>(materialPath);
                    if (material == null) { material = new Material(shader); AssetDatabase.CreateAsset(material, materialPath); }
                }
                for (int index = 0; index < doc.images.Length; index++)
                {
                    var image = doc.images[index];
                    if (image.width <= 0 || image.height <= 0) throw new InvalidDataException("地图图片尺寸无效。");
                    var input = Path.GetFullPath(Path.Combine(source, image.file));
                    if (!input.StartsWith(source, StringComparison.Ordinal)) throw new InvalidDataException("地图素材路径超出资源包目录。");
                    var assetPath = directory + "/Textures/" + index.ToString("D4") + ".png";
                    File.Copy(input, assetPath, true); AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceSynchronousImport);
                    var importer = (TextureImporter)AssetImporter.GetAtPath(assetPath);
                    importer.textureType = TextureImporterType.Sprite; importer.spriteImportMode = SpriteImportMode.Single;
                    importer.spritePixelsPerUnit = doc.pixelsPerUnit; importer.alphaIsTransparency = true;
                    importer.mipmapEnabled = false; importer.filterMode = FilterMode.Point; importer.textureCompression = TextureImporterCompression.Uncompressed; importer.maxTextureSize = 8192;
                    float pivotY = Mathf.Clamp01(1f - (image.baseline - image.y) / image.height);
                    var settings = new TextureImporterSettings(); importer.ReadTextureSettings(settings);
                    settings.spriteAlignment = (int)SpriteAlignment.Custom; settings.spritePivot = new Vector2(.5f, pivotY); importer.SetTextureSettings(settings); importer.SaveAndReimport();
                    var obj = new GameObject(string.IsNullOrEmpty(image.name) ? image.kind : image.name); obj.transform.SetParent(root.transform, false);
                    obj.transform.localPosition = new Vector3((image.x + image.width * .5f) / doc.pixelsPerUnit, -(image.y + image.height * (1f - pivotY)) / doc.pixelsPerUnit, 0);
                    var sprite = obj.AddComponent<SpriteRenderer>(); sprite.sprite = AssetDatabase.LoadAssetAtPath<Sprite>(assetPath); sprite.spriteSortPoint = SpriteSortPoint.Pivot;
                    if (material != null) sprite.sharedMaterial = material;
                    if (image.kind == "ground") sprite.sortingOrder = -30000;
                    else if (image.kind == "top") sprite.sortingOrder = 30000;
                    else { var sorter = obj.AddComponent<FactoryMapSort>(); sorter.map = map; sorter.baseline = image.baseline; sorter.sortOffset = image.sortOffset; sprite.sortingOrder = map.Order(image.baseline, image.sortOffset); }
                }
                foreach (var region in doc.regions ?? new MapRegion[0])
                {
                    if (region.type != "collision" && region.type != "adjustment") continue;
                    if (region.points == null || region.points.Length < 3) continue;
                    var obj = new GameObject(region.name ?? region.type); obj.transform.SetParent(root.transform, false);
                    var collider = obj.AddComponent<PolygonCollider2D>(); var points = new Vector2[region.points.Length];
                    for (int i = 0; i < points.Length; i++) points[i] = new Vector2(region.points[i].x / doc.pixelsPerUnit, -region.points[i].y / doc.pixelsPerUnit);
                    collider.SetPath(0, points);
                    if (region.type == "adjustment") { collider.isTrigger = true; obj.AddComponent<FactoryMapZone>().sortOffset = region.sortOffset; }
                }
                if (doc.collisionGrid != null && doc.collisionGrid.cells != null)
                {
                    var collisionGrid = doc.collisionGrid;
                    if (collisionGrid.columns <= 0 || collisionGrid.rows <= 0 || collisionGrid.cellWidthPx <= 0 || collisionGrid.cellHeightPx <= 0)
                        throw new InvalidDataException("碰撞网格参数无效。");
                    foreach (var cell in collisionGrid.cells)
                    {
                        if (cell == null || cell.row < 0 || cell.col < 0 || cell.row >= collisionGrid.rows || cell.col >= collisionGrid.columns)
                            throw new InvalidDataException("碰撞格行列坐标超出网格范围。");
                        var pixels = CollisionCellPolygon(collisionGrid, cell.row, cell.col);
                        var obj = new GameObject(string.Format("碰撞格 ({0},{1})", cell.row, cell.col)); obj.transform.SetParent(root.transform, false);
                        var collider = obj.AddComponent<PolygonCollider2D>(); var points = new Vector2[pixels.Length];
                        for (int i = 0; i < points.Length; i++) points[i] = new Vector2(pixels[i].x / doc.pixelsPerUnit, -pixels[i].y / doc.pixelsPerUnit);
                        collider.SetPath(0, points);
                    }
                }
                var prefab = PrefabUtility.SaveAsPrefabAsset(root, directory + "/" + safe + ".prefab");
                AssetDatabase.SaveAssets(); return prefab;
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        private static void ValidateRuntimeAssembly(Type component)
        {
            var name = component.Assembly.GetName().Name;
            foreach (var assembly in CompilationPipeline.GetAssemblies(AssembliesType.Editor))
            {
                if (assembly.name == name && (assembly.flags & AssemblyFlags.EditorAssembly) != 0)
                    throw new InvalidOperationException("运行时脚本 " + component.Name + " 被编译进了编辑器程序集 " + name + "，无法挂载到地图对象。\n\n请将整套 Unity 文件夹放到 Assets/Unity：\nAssets/Unity/Runtime（运行时组件）\nAssets/Unity/Editor（导入工具）\n\n不要放在 Assets/Editor/Unity，也不要把 Runtime 放在任何 Editor 目录或仅编辑器使用的程序集下。请移动原文件而不是复制第二份，等待重新编译后再导入 map.json。");
            }
        }

        private static Vector2[] CollisionCellPolygon(MapCollisionGrid grid, int row, int col)
        {
            var width = (float)grid.cellWidthPx; var height = (float)grid.cellHeightPx;
            var layout = grid.layout ?? "rectangle";
            var x = col; var y = row;
            if (layout == "isometric" || layout == "isometricZAsY") { x = grid.columns - 1 - col; y = grid.rows - 1 - row; }
            var boardWidth = grid.columns * width; var boardHeight = grid.rows * height;
            Vector2[] local;
            if (layout == "isometric" || layout == "isometricZAsY")
            {
                boardWidth = (grid.columns + grid.rows) * width / 2f; boardHeight = (grid.columns + grid.rows) * height / 2f;
                Func<float, float, Vector2> point = (gx, gy) => new Vector2((gx - gy + grid.rows) * width / 2f, (gx + gy) * height / 2f);
                local = new[] { point(x, y), point(x + 1, y), point(x + 1, y + 1), point(x, y + 1) };
            }
            else if (layout == "hexagon")
            {
                if (grid.hexOrientation == "flat")
                {
                    var shapeWidth = width * 1.08f; var shapeHeight = height; var stepX = shapeWidth * .75f;
                    boardWidth = (grid.columns - 1) * stepX + shapeWidth; boardHeight = grid.rows * shapeHeight + shapeHeight / 2f;
                    var center = new Vector2(x * stepX + shapeWidth / 2f, y * shapeHeight + ((x % 2 + 2) % 2) * shapeHeight / 2f + shapeHeight / 2f);
                    local = new[] { new Vector2(center.x - shapeWidth / 4f, center.y - shapeHeight / 2f), new Vector2(center.x + shapeWidth / 4f, center.y - shapeHeight / 2f), new Vector2(center.x + shapeWidth / 2f, center.y), new Vector2(center.x + shapeWidth / 4f, center.y + shapeHeight / 2f), new Vector2(center.x - shapeWidth / 4f, center.y + shapeHeight / 2f), new Vector2(center.x - shapeWidth / 2f, center.y) };
                }
                else
                {
                    var shapeWidth = width; var shapeHeight = height * 1.08f; var stepY = shapeHeight * .75f;
                    boardWidth = grid.columns * shapeWidth + shapeWidth / 2f; boardHeight = (grid.rows - 1) * stepY + shapeHeight;
                    var center = new Vector2(x * shapeWidth + ((y % 2 + 2) % 2) * shapeWidth / 2f + shapeWidth / 2f, y * stepY + shapeHeight / 2f);
                    local = new[] { new Vector2(center.x, center.y - shapeHeight / 2f), new Vector2(center.x + shapeWidth / 2f, center.y - shapeHeight / 4f), new Vector2(center.x + shapeWidth / 2f, center.y + shapeHeight / 4f), new Vector2(center.x, center.y + shapeHeight / 2f), new Vector2(center.x - shapeWidth / 2f, center.y + shapeHeight / 4f), new Vector2(center.x - shapeWidth / 2f, center.y - shapeHeight / 4f) };
                }
            }
            else
            {
                var left = x * width; var top = y * height;
                local = new[] { new Vector2(left, top), new Vector2(left + width, top), new Vector2(left + width, top + height), new Vector2(left, top + height) };
            }
            var originX = grid.centerX - boardWidth / 2f; var originY = grid.centerY - boardHeight / 2f;
            for (int i = 0; i < local.Length; i++) local[i] += new Vector2(originX, originY);
            return local;
        }
    }
}
#endif
