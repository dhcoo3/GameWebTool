using UnityEngine;

namespace GameAssetFactory.Maps
{
    [RequireComponent(typeof(PolygonCollider2D))]
    public class FactoryMapZone : MonoBehaviour
    {
        public int sortOffset;
        private PolygonCollider2D area;
        public bool Contains(Vector2 position)
        {
            if (area == null) area = GetComponent<PolygonCollider2D>();
            return area != null && area.enabled && area.OverlapPoint(position);
        }
    }
}
