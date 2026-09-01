import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  actor: {
    id: String,
    name: String,
    role: String,
  },
  action: { type: String, required: true },
  subject: { type: String, default: '' },
  details: { type: String, default: '' },
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
  diff: { type: mongoose.Schema.Types.Mixed, default: null },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  company: { type: String, default: 'Smaatech', index: true },
}, { timestamps: true });

auditLogSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.at = ret.createdAt;
    // Read .role off the actor sub-object before collapsing ret.actor down
    // to a plain name string below — doing it in the other order always
    // read .role off a string, so the role badge was blank for every entry.
    ret.role = ret.actor?.role || '';
    ret.actor = ret.actor?.name || 'System';
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('AuditLog', auditLogSchema);
