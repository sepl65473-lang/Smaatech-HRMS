export function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const details = error.details.map((detail) => detail.message).join(', ');
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: details,
        },
      });
    }

    req[property] = value;
    next();
  };
}
