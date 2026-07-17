import mongoose from 'mongoose';

const goalSchema = new mongoose.Schema({
  id: String,
  text: String,
  done: { type: Boolean, default: false },
}, { _id: false });

const reviewSchema = new mongoose.Schema({
  cycleName: { type: String, required: true },
  empId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  name: String,
  dept: String,
  status: { type: String, default: 'pending' }, // pending | self-submitted | completed
  selfRating: { type: Number, default: null },
  selfComments: { type: String, default: '' },
  managerRating: { type: Number, default: null },
  managerComments: { type: String, default: '' },
  goals: { type: [goalSchema], default: [] },
}, { timestamps: true });

reviewSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    ret.empId = String(ret.empId);
    delete ret._id;
    delete ret.__v;
  },
});

export default mongoose.model('Review', reviewSchema);
