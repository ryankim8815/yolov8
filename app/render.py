def encode_jpeg(frame, objects, quality):
    import cv2
    image = frame.copy()
    for obj in objects:
        x1, y1, x2, y2 = (int(v) for v in obj["xyxy"])
        cv2.rectangle(image, (x1, y1), (x2, y2), (65, 220, 170), 2)
        label = f'{obj["label"]} {obj["confidence"]:.2f}'
        cv2.putText(image, label, (x1, max(18, y1 - 7)), cv2.FONT_HERSHEY_SIMPLEX,
                    0.55, (65, 220, 170), 2, cv2.LINE_AA)
    ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("JPEG 인코딩에 실패했습니다.")
    return encoded.tobytes()
