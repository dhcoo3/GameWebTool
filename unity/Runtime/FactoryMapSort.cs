using UnityEngine;
using UnityEngine.Rendering;

namespace GameAssetFactory.Maps
{
    [ExecuteAlways]
    public class FactoryMapSort : MonoBehaviour
    {
        public FactoryMapRoot map;
        [Tooltip("Moving characters: enable this and assign the feet transform.")]
        public bool followTransform;
        public Transform feet;
        public float baseline;
        public int sortOffset;
        private SpriteRenderer sprite;
        private SortingGroup group;
        private void OnEnable() { sprite = GetComponent<SpriteRenderer>(); group = GetComponent<SortingGroup>(); }
        private void LateUpdate()
        {
            if (map == null) map = GetComponentInParent<FactoryMapRoot>();
            if (map == null) return;
            float pixelY = baseline;
            int extra = sortOffset;
            if (followTransform)
            {
                Vector3 position = feet != null ? feet.position : transform.position;
                pixelY = -map.transform.InverseTransformPoint(position).y * map.pixelsPerUnit;
                extra += map.ZoneOffset(position);
            }
            int order = map.Order(pixelY, extra);
            if (group != null) group.sortingOrder = order;
            else if (sprite != null) sprite.sortingOrder = order;
        }
    }
}
