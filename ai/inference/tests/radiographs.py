"""Builders for synthetic 2D DICOM files and PNG/JPEG image stacks."""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.sequence import Sequence
from pydicom.uid import (
    DigitalXRayImageStorageForPresentation,
    ExplicitVRLittleEndian,
    JPEG2000Lossless,
    JPEGBaseline8Bit,
    generate_uid,
)


def ramp(rows: int = 300, columns: int = 260, top: int = 4095) -> np.ndarray:
    """uint16 horizontal ramp 0..top: column c has value round(c * top / (columns - 1))."""
    line = np.rint(np.linspace(0, top, columns)).astype(np.uint16)
    return np.tile(line, (rows, 1))


def radiograph(
    pixels: np.ndarray | None = None,
    *,
    modality: str = "DX",
    photometric: str = "MONOCHROME2",
    bits: int = 12,
    **elements: Any,
) -> Dataset:
    """A single-frame uncompressed radiograph; `elements` are set as DICOM keywords."""
    pixels = ramp() if pixels is None else pixels
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = DigitalXRayImageStorageForPresentation
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.Modality = modality
    ds.PatientName = "Synthetic^Radiograph"
    ds.Rows, ds.Columns = pixels.shape[:2]
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = photometric
    ds.BitsAllocated = 16 if bits > 8 else 8
    ds.BitsStored = bits
    ds.HighBit = bits - 1
    ds.PixelRepresentation = 1 if pixels.dtype.kind == "i" else 0
    ds.PixelData = pixels.astype(pixels.dtype.newbyteorder("<")).tobytes()
    for keyword, value in elements.items():
        setattr(ds, keyword, value)
    return ds


def voi_lut_item(table: list[int], first: int = 0, bits: int = 16) -> Dataset:
    item = Dataset()
    item.LUTDescriptor = [len(table), first, bits]
    item.LUTData = table
    item["LUTData"].VR = "US"
    return item


def with_voi_lut(ds: Dataset, table: list[int], first: int = 0, bits: int = 16) -> Dataset:
    ds.VOILUTSequence = Sequence([voi_lut_item(table, first, bits)])
    return ds


def jpeg_baseline(pixels: np.ndarray, **elements: Any) -> Dataset:
    """8-bit grayscale JPEG Baseline (lossy) radiograph."""
    buf = io.BytesIO()
    Image.fromarray(pixels.astype(np.uint8)).save(buf, format="JPEG", quality=95)
    ds = radiograph(pixels.astype(np.uint8), bits=8, **elements)
    ds.file_meta.TransferSyntaxUID = JPEGBaseline8Bit
    ds.PixelData = encapsulate([buf.getvalue()])
    ds["PixelData"].VR = "OB"
    return ds


def jpeg2000_lossless(pixels: np.ndarray, **elements: Any) -> Dataset:
    """16-bit grayscale JPEG 2000 (reversible) radiograph; the codestream is written by Pillow."""
    buf = io.BytesIO()
    Image.fromarray(pixels.astype(np.uint16)).save(
        buf, format="JPEG2000", irreversible=False, no_jp2=True
    )
    ds = radiograph(pixels.astype(np.uint16), bits=16, **elements)
    ds.file_meta.TransferSyntaxUID = JPEG2000Lossless
    ds.PixelData = encapsulate([buf.getvalue()])
    ds["PixelData"].VR = "OB"
    return ds


def gdcm_transcode(src: Path, dest: Path, syntax: str) -> None:
    """Re-encode a DICOM file with GDCM (e.g. `JPEGLosslessProcess14_1`, `JPEGLSLossless`)."""
    import gdcm

    reader = gdcm.ImageReader()
    reader.SetFileName(str(src))
    assert reader.Read(), "gdcm could not read the source file"
    change = gdcm.ImageChangeTransferSyntax()
    change.SetTransferSyntax(gdcm.TransferSyntax(getattr(gdcm.TransferSyntax, syntax)))
    change.SetInput(reader.GetImage())
    assert change.Change(), f"gdcm could not encode {syntax}"
    writer = gdcm.ImageWriter()
    writer.SetFileName(str(dest))
    writer.SetFile(reader.GetFile())
    writer.SetImage(change.GetOutput())
    assert writer.Write(), "gdcm could not write the file"


def save(ds: Dataset, path: Path) -> Path:
    ds.save_as(path, enforce_file_format=True)
    return path


def image_bytes(array: np.ndarray, fmt: str = "PNG") -> bytes:
    buf = io.BytesIO()
    Image.fromarray(array).save(buf, format=fmt)
    return buf.getvalue()


def slice_image(k: int, width: int = 40, height: int = 30, dtype: type = np.uint8) -> np.ndarray:
    """Image k of a stack: value k everywhere except a marker pixel (row 2, column 5) = 200 + k,
    so both the slice order and the in-plane orientation can be checked."""
    image = np.full((height, width), k, dtype=dtype)
    image[2, 5] = 200 + k
    return image
