"""Verify class competition and conservative handling of uncertain evidence."""
import unittest
import numpy as np
from prepare_segmented_view import classify


class ClassificationTests(unittest.TestCase):
    def test_strongest_category_and_stable_ties(self):
        fields = [np.array([0, 5, 6, 40, 20], dtype=np.uint8),
                  np.array([0, 4, 6, 60, 10], dtype=np.uint8),
                  np.array([0, 0, 0, 30, 90], dtype=np.uint8)]
        np.testing.assert_array_equal(classify(fields), [0, 0, 1, 2, 3])

    def test_absent_categories_are_never_invented(self):
        fields = [np.zeros(8, dtype=np.uint8) for _ in range(5)]
        np.testing.assert_array_equal(classify(fields), np.zeros(8))


if __name__ == '__main__':
    unittest.main()
