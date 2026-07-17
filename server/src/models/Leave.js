import mongoose from 'mongoose';

const leaveSchema = new mongoose.Schema({
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  name: String,
  dept: String,
  type: { type: String, required: true }, // sick | casual | earned
  start: { type: String, required: true }, // YYYY-MM-DD
  end: { type: String, required: true },
  status: { type: String, default: 'pending' }, // pending | approved | declined
  reason: { type: String, default: '' },
}, { timestamps: true });

leaveSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.empId = String(ret.empId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Leave', leaveSchema);
