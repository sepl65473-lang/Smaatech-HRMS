// Mongoose plugin to automatically apply tenant (company) scoping on queries
export function tenantPlugin(schema) {
  schema.pre(['find', 'findOne', 'findOneAndUpdate', 'countDocuments', 'updateMany', 'deleteOne', 'deleteMany'], function () {
    // If tenant option is passed on query call e.g. .find().option({ tenant: 'Smaatech' })
    const tenant = this.options?.tenant;
    if (tenant && !this._conditions.company) {
      this._conditions.company = tenant;
    }
  });
}
