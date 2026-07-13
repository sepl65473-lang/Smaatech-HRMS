import mongoose from 'mongoose';

const faceDescriptorSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  descriptor: { type: [Number], required: true }, // 128 floats, computed server-side only
  photoRef: { type: String, default: null },
  enrolledAt: { type: Date, default: Date.now },
}, { timestamps: true });

export default mongoose.model('FaceDescriptor', faceDescriptorSchema);
