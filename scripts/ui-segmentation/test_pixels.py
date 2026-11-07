import unittest
import numpy as np
from PIL import Image
from pixels import place_mask, source_rgba, visible_ownership, composite_reconstruction
from worker import checked_box, region_for_box


class PixelTests(unittest.TestCase):
    def test_region_coordinates_and_edges(self):
        self.assertEqual(region_for_box({"x": 5, "y": 10, "width": 20, "height": 30}, 100, 100), (0, 0, 89, 100))
        with self.assertRaises(ValueError):
            checked_box({"x": 1.2, "y": 0, "width": 1, "height": 1}, 100, 100)
        with self.assertRaises(ValueError):
            checked_box({"x": 99, "y": 0, "width": 2, "height": 1}, 100, 100)

    def test_mask_mapping_is_exact_and_never_stretches(self):
        small = Image.fromarray(np.array([[0, 255], [255, 0]], dtype=np.uint8))
        bounds = {"x": 3, "y": 2, "width": 2, "height": 2}
        mask = np.asarray(place_mask(small, bounds, (8, 6)))
        self.assertEqual(mask[2, 4], 255)
        self.assertEqual(mask[3, 3], 255)
        self.assertEqual(np.count_nonzero(mask), 2)
        with self.assertRaises(ValueError):
            place_mask(small, {**bounds, "width": 3}, (8, 6))

    def test_original_rgb_survives_alpha_changes(self):
        rgba = np.array([[[31, 67, 211, 255], [192, 24, 1, 127]]], dtype=np.uint8)
        mask = Image.fromarray(np.array([[255, 128]], dtype=np.uint8))
        result = np.asarray(source_rgba(Image.fromarray(rgba), mask))
        np.testing.assert_array_equal(result[:, :, :3], rgba[:, :, :3])
        self.assertEqual(result[0, 1, 3], 64)

    def test_child_pixels_are_removed_from_parent_and_residual(self):
        child = Image.fromarray(np.array([[0, 255, 0, 0]], dtype=np.uint8))
        parent = Image.fromarray(np.array([[255, 255, 255, 0]], dtype=np.uint8))
        layers, background = visible_ownership([child, parent])
        np.testing.assert_array_equal(np.asarray(layers[1]), [[255, 0, 255, 0]])
        np.testing.assert_array_equal(np.asarray(background), [[0, 0, 0, 255]])

    def test_reconstruction_cannot_change_pixels_outside_mask(self):
        source = Image.fromarray(np.array([[[1, 2, 3, 255], [23, 51, 97, 128]]], dtype=np.uint8))
        generated = Image.new("RGBA", (2, 1), (250, 190, 170, 255))
        mask = Image.fromarray(np.array([[255, 0]], dtype=np.uint8))
        result = np.asarray(composite_reconstruction(source, generated, mask))
        np.testing.assert_array_equal(result[0, 1], np.asarray(source)[0, 1])
        np.testing.assert_array_equal(result[0, 0], np.asarray(generated)[0, 0])
        with self.assertRaises(ValueError):
            composite_reconstruction(source, Image.new("RGBA", (3, 1)), mask)


if __name__ == "__main__":
    unittest.main()
