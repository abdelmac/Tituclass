import { fail, text } from './auth.js';
export const fields = ['title','subject','type','subgroup','date','start','end','building','room','address','meeting','instructor','attendance','status','notes','links'];
export const labels = { title:'Title',subject:'Subject',type:'Event type',subgroup:'Subgroup',date:'Date',start:'Start time',end:'End time',building:'Building',room:'Room',address:'Address',meeting:'Meeting link',instructor:'Instructor',attendance:'Attendance',status:'Status',notes:'Instructions',links:'Resources' };
export function validateEvent(body) {
  const data = {};
  for (const field of fields) data[field] = text(body[field] ?? '', labels[field], ['notes','links'].includes(field) ? 4000 : 250, ['title','subject'].includes(field));
  data.type ||= 'lecture'; data.attendance ||= 'unknown'; data.status ||= 'scheduled';
  if (!['lecture','practical','tutorial','exam','other'].includes(data.type)) fail(400, 'Invalid event type.');
  if (!['required','not_required','unknown'].includes(data.attendance)) fail(400, 'Invalid attendance status.');
  if (!['scheduled','rescheduled','cancelled'].includes(data.status)) fail(400, 'Invalid event status.');
  if (data.date && (!/^\d{4}-\d{2}-\d{2}$/.test(data.date) || !Number.isFinite(Date.parse(data.date+'T12:00:00Z')) || new Date(data.date + 'T12:00:00Z').toISOString().slice(0,10) !== data.date)) fail(400, 'Enter a valid date or leave it to be confirmed.');
  for (const field of ['start','end']) if (data[field] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data[field])) fail(400, 'Enter a valid time.');
  if (data.start && data.end && data.end <= data.start) fail(400, 'End time must be after start time.');
  for (const url of [data.meeting, ...data.links.split('\n')].filter(Boolean)) {
    try { if (!['https:','http:'].includes(new URL(url).protocol)) throw Error(); }
    catch { fail(400, 'Resource and meeting links must be valid HTTP or HTTPS URLs.'); }
  }
  return data;
}
export const readable = value => ({required:'Required',not_required:'Not required',unknown:'Unknown',scheduled:'Scheduled',rescheduled:'Rescheduled',cancelled:'Cancelled'}[value] || value || 'To be confirmed');
export function changes(oldData, data) {
  return fields.filter(field => oldData[field] !== data[field]).map(field => ({field, before:oldData[field], after:data[field], message:`${labels[field]} changed from ${readable(oldData[field])} to ${readable(data[field])}`}));
}
export function serializeEvent(row) { return { ...JSON.parse(row.data), id:row.id, classId:row.class_id, seriesId:row.series_id, version:row.version, updatedAt:row.updated_at, updatedBy:row.updated_by }; }
