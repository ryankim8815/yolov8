"""Publish actual E0509 monitoring registers as a separate, read-only JointState stream."""
import math
import os
import socket
import struct
import time

def receive_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        chunk = stream.recv(size - len(result))
        if not chunk:
            raise ConnectionError("controller closed the connection")
        result.extend(chunk)
    return result


def read_positions(stream, transaction):
    # Doosan Modbus TCP Slave I/O table: holding registers 270..275,
    # signed 16-bit values in tenths of a degree. FC03 is read-only.
    stream.sendall(struct.pack(">HHHBBHH", transaction, 0, 6, 255, 3, 270, 6))
    xid, protocol, length, unit = struct.unpack(">HHHB", receive_exact(stream, 7))
    if (xid, protocol, length, unit) != (transaction, 0, 15, 255):
        raise ValueError("unexpected Modbus response header")
    payload = receive_exact(stream, length - 1)
    if payload[:2] != bytes((3, 12)):
        raise ValueError("unexpected Modbus function or byte count")
    return [math.radians(value / 10.0) for value in struct.unpack(">6h", payload[2:])]


def main():
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import JointState

    rclpy.init()
    namespace = os.environ["ROBOT_NAMESPACE"].strip("/")
    node = Node("controller_joint_monitor", namespace="/" + namespace)
    output = node.create_publisher(JointState, "monitor/joint_states", 1)
    address = (os.environ["ROBOT_IP"], int(os.getenv("ROBOT_MODBUS_PORT", "502")))
    names = [f"joint_{n}" for n in range(1, 7)]
    transaction = 0
    try:
        while rclpy.ok():
            try:
                with socket.create_connection(address, timeout=1.5) as stream:
                    while rclpy.ok():
                        positions = read_positions(stream, transaction)
                        transaction = (transaction + 1) % 65536
                        message = JointState()
                        message.header.stamp = node.get_clock().now().to_msg()
                        message.name, message.position = names, positions
                        output.publish(message)
                        time.sleep(0.1)
            except (OSError, ValueError) as exc:
                node.get_logger().warning(f"Controller joint read failed: {exc}", throttle_duration_sec=10)
                time.sleep(2)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
