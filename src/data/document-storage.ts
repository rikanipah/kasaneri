import { t } from '../core/i18n';
import { projectDocument, readLegacyDocument, readStoredDocument, validAttachmentDocument, type CardDocuments } from '../core/attachment-document';

export interface StoredDocuments {content:string;answer:string;content_objects:string;answer_objects:string}

export function storeDocuments(content:string,answer:string,documents?:CardDocuments):StoredDocuments{
  if(documents&&(!validAttachmentDocument(documents.content)||!validAttachmentDocument(documents.answer))){
    throw Error(t('无效正文。'));
  }
  const compatible=(source:string,document:CardDocuments['content']|undefined)=>document&&
    (source===document.text||source===projectDocument(document))?document:readLegacyDocument(source);
  const value={content:compatible(content,documents?.content),answer:compatible(answer,documents?.answer)};
  return {content:value.content.text,answer:value.answer.text,
    content_objects:JSON.stringify(value.content.objects),answer_objects:JSON.stringify(value.answer.objects)};
}

export function readDocuments(row:StoredDocuments):CardDocuments{
  return {content:readStoredDocument(row.content,row.content_objects),answer:readStoredDocument(row.answer,row.answer_objects)};
}

export function projectStoredDocuments(row:StoredDocuments):{content:string;answer:string}{
  const value=readDocuments(row);
  return {content:projectDocument(value.content),answer:projectDocument(value.answer)};
}
