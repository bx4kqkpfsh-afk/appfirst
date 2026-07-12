from pathlib import Path

from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "fixtures" / "docvision-two-page-benchmark.pdf"
IMAGES = [
    ROOT / "fixtures" / "docvision-benchmark.png",
    ROOT / "fixtures" / "docvision-benchmark-tilted.jpg",
]


def main() -> None:
    page_width, page_height = landscape(A4)
    document = canvas.Canvas(str(OUTPUT), pagesize=(page_width, page_height))
    document.setTitle("DocVision two-page PDF benchmark")
    for page_number, image_path in enumerate(IMAGES, start=1):
        document.setFont("Helvetica-Bold", 11)
        document.drawString(24, page_height - 20, f"DocVision PDF benchmark - page {page_number}")
        document.drawImage(
            str(image_path),
            24,
            24,
            width=page_width - 48,
            height=page_height - 58,
            preserveAspectRatio=True,
            anchor="c",
        )
        document.showPage()
    document.save()
    print(OUTPUT)


if __name__ == "__main__":
    main()
