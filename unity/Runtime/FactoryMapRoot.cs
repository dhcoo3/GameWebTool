using System;
using UnityEngine;

namespace GameAssetFactory.Maps
{
    [Serializable] public class MapPoint { public float x; public float y; }
    [Serializable] public class MapImage
    {
        public string file, name, kind;
        public float x, y, width, height, baseline;
        public int sortOffset;
    }
    [Serializable] public class MapRegion
    {
        public string id, name, type;
        public MapPoint[] points;
        public float baseline;
        public int sortOffset;
        public bool visible = true;
    }
    [Serializable] public class MapGridCell { public int row; public int col; }
    [Serializable] public class MapCollisionGrid
    {
        public string coordinateSystem, indexOrigin, layout, hexOrientation;
        public int columns, rows, cellWidthPx, cellHeightPx;
        public float centerX, centerY;
        public MapGridCell[] cells;
    }
    [Serializable] public class MapDocument
    {
        public string format, name;
        public int version;
        public float pixelsPerUnit, originX, originY, width, height;
        public MapImage[] images;
        public MapRegion[] regions;
        public MapCollisionGrid collisionGrid;
    }
    public class FactoryMapRoot : MonoBehaviour
    {
        public float pixelsPerUnit = 100f;
        public float originY;
        public float height = 1024f;
        [NonSerialized] private FactoryMapZone[] zones;
        public int Order(float pixelY, int offset = 0)
        {
            return Mathf.Clamp(Mathf.RoundToInt((pixelY - originY) / Mathf.Max(1f, height) * 28000f) - 14000 + offset, -28000, 28000);
        }
        public int ZoneOffset(Vector2 point)
        {
            if (zones == null) zones = GetComponentsInChildren<FactoryMapZone>(true);
            int result = 0;
            foreach (var zone in zones)
                if (zone.isActiveAndEnabled && zone.Contains(point)) result += zone.sortOffset;
            return result;
        }
        private void OnTransformChildrenChanged() { zones = null; }
    }
}
