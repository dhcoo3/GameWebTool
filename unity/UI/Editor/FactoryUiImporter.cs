#if UNITY_EDITOR
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace GameAssetFactory.UI.Editor
{
    [Serializable]
    public sealed class UiReferenceResolution
    {
        public int width;
        public int height;
    }

    [Serializable]
    public sealed class UiAssetBounds
    {
        public int x;
        public int y;
        public int width;
        public int height;
    }

    [Serializable]
    public sealed class UiAssetEntry
    {
        public string id;
        public string name;
        public string category;
        public int order;
        public UiAssetBounds bounds;
        public string cropFile;
        public string extractionMode;
        public string maskFile;
        public float confidence;
        public string notes;
        public string parentId;
        public int zIndex;
        public string generatedMaskFile;
        public string provenance;
    }

    [Serializable]
    public sealed class UiLogicalGroup
    {
        public string id;
        public string parentId;
        public string name;
    }

    [Serializable]
    public sealed class UiManifest
    {
        public string format;
        public int version;
        public string name;
        public string coordinateSystem;
        public UiReferenceResolution referenceResolution;
        public UiAssetEntry[] assets;
        public UiLogicalGroup[] groups;
    }

    public static class FactoryUiImporter
    {
        [MenuItem("Tools/生产工厂/导入 UI 资源")]
        public static void Open()
        {
            var file = EditorUtility.OpenFilePanel("选择 UI 资源包中的 manifest.json", "", "json");
            if (string.IsNullOrEmpty(file)) return;
            try { Selection.activeObject = Import(file); }
            catch (Exception error) { Debug.LogException(error); EditorUtility.DisplayDialog("UI 导入失败", error.Message, "确定"); }
        }

        public static GameObject Import(string manifestPath)
        {
            var manifest = JsonUtility.FromJson<UiManifest>(File.ReadAllText(manifestPath));
            if (manifest == null || manifest.format != "game-asset-factory-ui" || (manifest.version != 1 && manifest.version != 2) || manifest.referenceResolution == null)
                throw new InvalidDataException("UI 资源清单格式或版本不受支持。");
            int canvasWidth = manifest.referenceResolution.width, canvasHeight = manifest.referenceResolution.height;
            var assets = manifest.assets;
            if (canvasWidth <= 0 || canvasHeight <= 0 || canvasWidth > 8192 || canvasHeight > 8192 || assets == null || assets.Length < 1 || assets.Length > 500)
                throw new InvalidDataException("UI 画布尺寸或素材数量无效。");

            var sourceDirectory = Path.GetFullPath(Path.GetDirectoryName(manifestPath)) + Path.DirectorySeparatorChar;
            var safeName = SafeName(manifest.name);
            var outputDirectory = "Assets/GeneratedUI/" + safeName;
            var textureDirectory = outputDirectory + "/Sprites";
            Directory.CreateDirectory(textureDirectory);
            var root = new GameObject(safeName, typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            try
            {
                var canvas = root.GetComponent<Canvas>(); canvas.renderMode = RenderMode.ScreenSpaceOverlay;
                var scaler = root.GetComponent<CanvasScaler>(); scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
                scaler.referenceResolution = new Vector2(canvasWidth, canvasHeight); scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight; scaler.matchWidthOrHeight = .5f;

                var groups = new Dictionary<string, RectTransform>();
                if (manifest.version == 2 && manifest.groups != null)
                {
                    if (manifest.groups.Length > 500) throw new InvalidDataException("逻辑分组过多。");
                    var definitions = new Dictionary<string, UiLogicalGroup>();
                    foreach (var group in manifest.groups)
                    {
                        if (string.IsNullOrEmpty(group.id) || definitions.ContainsKey(group.id)) throw new InvalidDataException("重复或空的逻辑分组 ID。");
                        definitions.Add(group.id, group);
                        var obj = new GameObject(SafeName(group.name), typeof(RectTransform));
                        obj.transform.SetParent(root.transform, false);
                        groups.Add(group.id, obj.GetComponent<RectTransform>());
                    }
                    foreach (var group in manifest.groups)
                    {
                        var visited = new HashSet<string> { group.id }; var parent = group.parentId;
                        while (!string.IsNullOrEmpty(parent))
                        {
                            if (!definitions.ContainsKey(parent) || !visited.Add(parent)) throw new InvalidDataException("无效或循环的逻辑父子关系。");
                            parent = definitions[parent].parentId;
                        }
                        var rect = groups[group.id];
                        rect.SetParent(string.IsNullOrEmpty(group.parentId) ? root.transform : groups[group.parentId], false);
                        rect.anchorMin = Vector2.zero; rect.anchorMax = Vector2.one; rect.offsetMin = Vector2.zero; rect.offsetMax = Vector2.zero;
                        rect.localScale = Vector3.one;
                    }
                }

                int drawIndex = 0;
                foreach (var entry in assets.OrderBy(asset => asset.order))
                {
                    ValidateEntry(entry, canvasWidth, canvasHeight);
                    var sourcePath = ResolveInside(sourceDirectory, entry.cropFile);
                    var textureName = Path.GetFileName(entry.cropFile);
                    var destinationPath = textureDirectory + "/" + textureName;
                    File.Copy(sourcePath, destinationPath, true);
                    AssetDatabase.ImportAsset(destinationPath, ImportAssetOptions.ForceSynchronousImport);
                    var importer = AssetImporter.GetAtPath(destinationPath) as TextureImporter;
                    if (importer == null) throw new InvalidDataException("无法读取 UI 图片导入设置：" + destinationPath);
                    importer.textureType = TextureImporterType.Sprite; importer.spriteImportMode = SpriteImportMode.Single;
                    importer.alphaIsTransparency = true; importer.mipmapEnabled = false; importer.textureCompression = TextureImporterCompression.Uncompressed;
                    importer.filterMode = FilterMode.Bilinear; importer.maxTextureSize = 8192; importer.SaveAndReimport();
                    var sprite = AssetDatabase.LoadAssetAtPath<Sprite>(destinationPath);
                    if (sprite == null) throw new InvalidDataException("UI 图片没有成功导入为 Sprite：" + destinationPath);
                    var child = new GameObject(SafeName(entry.name), typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
                    RectTransform logicalParent;
                    child.transform.SetParent(manifest.version == 2 && groups.TryGetValue(entry.id, out logicalParent) ? logicalParent : root.transform, false);
                    var rect = child.GetComponent<RectTransform>(); rect.anchorMin = new Vector2(0f, 1f); rect.anchorMax = new Vector2(0f, 1f); rect.pivot = new Vector2(0f, 1f);
                    rect.sizeDelta = new Vector2(entry.bounds.width, entry.bounds.height); rect.anchoredPosition = new Vector2(entry.bounds.x, -entry.bounds.y);
                    var image = child.GetComponent<Image>(); image.sprite = sprite; image.preserveAspect = false; image.raycastTarget = false;
                    if (manifest.version == 2)
                    {
                        var layerCanvas = child.AddComponent<Canvas>(); layerCanvas.overrideSorting = true; layerCanvas.sortingOrder = drawIndex++;
                    }
                }

                var prefabPath = outputDirectory + "/" + safeName + ".prefab";
                var prefab = PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
                AssetDatabase.SaveAssets();
                if (prefab == null) throw new InvalidOperationException("Unity 未能保存 UI Prefab。");
                return prefab;
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        private static void ValidateEntry(UiAssetEntry entry, int canvasWidth, int canvasHeight)
        {
            if (entry == null || entry.bounds == null || string.IsNullOrWhiteSpace(entry.cropFile)) throw new InvalidDataException("UI 素材缺少坐标或图片路径。");
            var box = entry.bounds;
            if (box.x < 0 || box.y < 0 || box.width < 1 || box.height < 1 || box.x + box.width > canvasWidth || box.y + box.height > canvasHeight)
                throw new InvalidDataException("UI 素材坐标超出参考画布：" + entry.name);
        }

        private static string ResolveInside(string root, string relativePath)
        {
            var fullPath = Path.GetFullPath(Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar)));
            if (!fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(fullPath))
                throw new InvalidDataException("UI 素材路径无效或文件不存在：" + relativePath);
            return fullPath;
        }

        private static string SafeName(string value)
        {
            var result = string.Join("_", (value ?? "UI").Split(Path.GetInvalidFileNameChars())).Replace('/', '_').Replace('\\', '_').Trim();
            return string.IsNullOrWhiteSpace(result) ? "UI" : result;
        }
    }
}
#endif
