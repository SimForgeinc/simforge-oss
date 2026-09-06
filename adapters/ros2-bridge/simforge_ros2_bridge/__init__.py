"""SimForge ROS 2 bridge — lockstepped clock/TF/odometry out, Ackermann control in.

Steps the native SimForge runtime in-process through the ``simforge_oss_gym``
SDK and mirrors each decision into a ROS 2 graph under deterministic sim time.
"""

__all__ = ["episode", "trace", "bag_io"]
