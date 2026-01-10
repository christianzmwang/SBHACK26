export const handleError = (error, res) => {
  console.error('Error:', error);
  
  if (res && !res.headersSent) {
    const statusCode = error.statusCode || 500;
    const message = error.message || 'Internal server error';
    
    res.status(statusCode).json({
      success: false,
      error: message
    });
  }
};

export const errorHandler = (err, req, res, next) => {
  handleError(err, res);
};
