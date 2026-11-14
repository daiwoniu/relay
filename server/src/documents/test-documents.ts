import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PDFDocument, rgb } from 'pdf-lib';

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

export async function createPdfBuffer(pageCount: number, withImage = false): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const image = withImage ? await pdf.embedPng(TINY_PNG) : null;
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdf.addPage([320, 240]);
    page.drawText(`Page ${index + 1}`, { x: 20, y: 200, size: 14, color: rgb(0, 0, 0) });
    if (image) page.drawImage(image, { x: 20, y: 20, width: 120, height: 120 });
  }
  return Buffer.from(await pdf.save());
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function createDocxBuffer(options: {
  paragraphs: string[];
  savedPages?: number;
  includeImage?: boolean;
  renderedPageBreakAfter?: number[];
}): Promise<Buffer> {
  const zip = new JSZip();
  const imageRelationship = options.includeImage
    ? '<Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>'
    : '';
  const imageXml = options.includeImage
    ? '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="image.png"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="image.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImage1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
    : '';
  const breakIndexes = new Set(options.renderedPageBreakAfter ?? []);
  const paragraphs = options.paragraphs.map((text, index) => `<w:p><w:r><w:t>${escapeXml(text)}</w:t>${breakIndexes.has(index + 1) ? '<w:lastRenderedPageBreak/>' : ''}</w:r></w:p>`).join('');

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}${imageXml}<w:sectPr/></w:body></w:document>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${imageRelationship}</Relationships>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>${options.savedPages ?? 0}</Pages></Properties>`);
  if (options.includeImage) zip.file('word/media/image1.png', TINY_PNG);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function createXlsxBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const visible = workbook.addWorksheet('数据');
  visible.addRow(['名称', '日期', '公式']);
  visible.addRow(['测试', new Date('2026-08-08T00:00:00Z'), { formula: '1+1', result: 2 }]);
  visible.mergeCells('A3:B3');
  visible.getCell('A3').value = '合并';
  for (let index = 0; index < 55; index += 1) visible.addRow([`第 ${index + 1} 行`]);
  const hidden = workbook.addWorksheet('隐藏');
  hidden.state = 'hidden';
  hidden.addRow(['不可见']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
