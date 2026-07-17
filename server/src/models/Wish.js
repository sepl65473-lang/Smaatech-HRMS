import mongoose from 'mongoose';

// Tracks which birthday/anniversary "occurrence" has already been wished —
// celebration entries themselves are computed on the fly from Employee.dob/
// joinDate (see routes/celebrations.js), not stored, so this is the only
// piece of celebration state that actually needs persisting.
const wishSchema = new mongoose.Schema({
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  type: { type: String, required: true }, // birthday | anniv
  year: { type: Number, required: true },
}, { timestamps: true });

wishSchema.index({ employeeId: 1, type: 1, year: 1 }, { unique: true });

export default mongoose.model('Wish', wishSchema);
