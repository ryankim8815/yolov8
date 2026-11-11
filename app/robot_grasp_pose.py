"""Preset-owned ZYZ tool orientation, independent of camera registration."""
import math


def default_abc(region):
    return [0,180,0] if region=="floor" else [180,90,90]


def grasp_abc(preset,fallback=None):
    explicit=preset.get("grasp_abc",{}).get(preset["region"])
    if explicit is not None:return list(explicit)
    if fallback is not None and len(fallback)==3 and all(v is not None for v in fallback):return list(fallback)
    return default_abc(preset["region"])


def tool_x(abc):
    a,b,c=map(math.radians,abc)
    return [math.cos(a)*math.cos(b)*math.cos(c)-math.sin(a)*math.sin(c),
            math.sin(a)*math.cos(b)*math.cos(c)+math.cos(a)*math.sin(c),-math.sin(b)*math.cos(c)]
