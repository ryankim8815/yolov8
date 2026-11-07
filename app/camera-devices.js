// JXA (osascript): match the device types and uniqueID ordering used by
// OpenCV 4.11's cap_avfoundation_mac.mm, without opening a capture session.
ObjC.import("AVFoundation");
const device = $.NSClassFromString("AVCaptureDevice");
const devices = device.devicesWithMediaType($.AVMediaTypeVideo)
  .arrayByAddingObjectsFromArray(device.devicesWithMediaType($.AVMediaTypeMuxed))
  .sortedArrayUsingDescriptors($.NSArray.arrayWithObject(
    $.NSSortDescriptor.sortDescriptorWithKeyAscending("uniqueID", true)));
JSON.stringify(Array.from({length: Number(devices.count)}, (_, index) => {
  const camera = devices.objectAtIndex(index);
  return {index, id: ObjC.unwrap(camera.uniqueID), name: ObjC.unwrap(camera.localizedName)};
}));
