import unittest
from snapshot import change_points


class ChangePoints(unittest.TestCase):
    def test_keeps_first_changes_and_last(self):
        s = [[1, '0'], [2, '0'], [3, '1'], [4, '1'], [5, '1']]
        self.assertEqual(change_points(s), [[1, '0'], [3, '1'], [5, '1']])

    def test_single_and_empty(self):
        self.assertEqual(change_points([[1, '3']]), [[1, '3']])
        self.assertEqual(change_points([]), [])


if __name__ == '__main__':
    unittest.main()
