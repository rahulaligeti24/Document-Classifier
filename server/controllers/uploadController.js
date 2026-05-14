const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const Upload = require('../models/Upload');
const { promisify } = require('util');

// Promisify fs functions to handle file operations properly
const unlinkAsync = promisify(fs.unlink);
const copyFileAsync = promisify(fs.copyFile);
const mkdirAsync = promisify(fs.mkdir);

// Utility function to delete file safely
const deleteFileSafely = async (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      await unlinkAsync(filePath);
    }
  } catch (error) {
    console.error('Error deleting file:', filePath, error.message);
    // Don't throw - just log the error
  }
};

// Utility function to move file safely
const moveFileSafely = async (sourcePath, destinationPath) => {
  try {
    // Ensure destination directory exists
    const destDir = path.dirname(destinationPath);
    if (!fs.existsSync(destDir)) {
      await mkdirAsync(destDir, { recursive: true });
    }
    
    // Copy and then delete (move operation)
    await copyFileAsync(sourcePath, destinationPath);
    await deleteFileSafely(sourcePath);
    return true;
  } catch (error) {
    console.error('Error moving file:', sourcePath, error.message);
    return false;
  }
};

// @desc    Upload PDF and send to ML service
// @route   POST /api/uploads
// @access  Private
exports.uploadFile = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please upload at least one PDF file',
      });
    }

    // Process ALL files
    const uploadResults = [];
    const failedFiles = [];

    for (const file of req.files) {
      const { originalname: filename, path: filePath, size } = file;

      try {
        // Create form data for ML service
        const formData = new FormData();
        const fileStream = fs.createReadStream(filePath);
        formData.append('file', fileStream, filename);

        console.log(`[ML Service] Sending: ${filename} to ${process.env.ML_SERVICE_URL}`);

        // Send to Python ML service
        const mlResponse = await axios.post(process.env.ML_SERVICE_URL, formData, {
          headers: formData.getHeaders(),
          timeout: 30000, // 30 second timeout
        });

        const { data: responseData } = mlResponse.data;
        const { predicted_label: label, confidence } = responseData;

        console.log(`[ML Service] Response for ${filename}: label=${label}, confidence=${confidence}`);

        // Validate ML response
        if (!label) {
          throw new Error('Invalid response from ML service');
        }

        // Save to database
        const upload = await Upload.create({
          userId: req.userId,
          originalFileName: filename,
          predictedLabel: label,
          confidence: confidence || null,
          filePath: filePath,
          fileSize: size,
          status: 'completed',
        });

        uploadResults.push({
          id: upload._id,
          fileName: upload.originalFileName,
          label: upload.predictedLabel,
          confidence: upload.confidence,
          uploadedAt: upload.createdAt,
        });

        // Move file to permanent storage
        const permanentDir = process.env.UPLOAD_PERMANENT_DIR || './uploads/documents';
        
        // Ensure directory exists
        if (!fs.existsSync(permanentDir)) {
          fs.mkdirSync(permanentDir, { recursive: true });
        }
        
        const permanentPath = path.join(permanentDir, `${upload._id}.pdf`);
        console.log(`[File Move] Moving ${filename} from ${filePath} to ${permanentPath}`);
        
        const moved = await moveFileSafely(filePath, permanentPath);
        if (moved) {
          // Update database with permanent path
          upload.filePath = permanentPath;
          await upload.save();
          console.log(`[File Move] ✓ Successfully moved file for upload ${upload._id}`);
        } else {
          console.log(`[File Move] ✗ Failed to move file for upload ${upload._id}`);
        }
      } catch (mlError) {
        console.error(`[Error] Failed to classify ${filename}:`, mlError.message);

        // Save failed upload record
        const failedUpload = await Upload.create({
          userId: req.userId,
          originalFileName: filename,
          predictedLabel: 'Unknown',
          filePath: filePath,
          fileSize: size,
          status: 'failed',
          error: mlError.message,
        });

        failedFiles.push({
          fileName: filename,
          error: mlError.message,
          id: failedUpload._id,
        });

        // Move failed file to permanent storage for reference
        const permanentDir = process.env.UPLOAD_PERMANENT_DIR || './uploads/documents';
        
        // Ensure directory exists
        if (!fs.existsSync(permanentDir)) {
          fs.mkdirSync(permanentDir, { recursive: true });
        }
        
        const permanentPath = path.join(permanentDir, `${failedUpload._id}.pdf`);
        
        const moved = await moveFileSafely(filePath, permanentPath);
        if (moved) {
          failedUpload.filePath = permanentPath;
          await failedUpload.save();
        }
      }
    }

    // Return response
    if (uploadResults.length > 0) {
      return res.status(201).json({
        success: true,
        message: `${uploadResults.length} file(s) uploaded successfully${failedFiles.length > 0 ? `, ${failedFiles.length} failed` : ''}`,
        data: {
          uploads: uploadResults,
          failed: failedFiles.length > 0 ? failedFiles : undefined,
        },
      });
    } else {
      return res.status(400).json({
        success: false,
        message: 'All files failed to process',
        data: {
          failed: failedFiles,
        },
      });
    }
  } catch (error) {
    // Clean up temp files if exists
    if (req.files && req.files.length > 0) {
      await Promise.all(
        req.files.map((file) => deleteFileSafely(file.path))
      );
    }

    console.error('[Error] Upload processing error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Error processing file',
    });
  }
};

// @desc    Get upload history for user
// @route   GET /api/uploads/history
// @access  Private
exports.getUploadHistory = async (req, res) => {
  try {
    const { page = 1, limit = 10, sort = '-createdAt' } = req.query;

    // Parse query params
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    // Get total count
    const totalCount = await Upload.countDocuments({ userId: req.userId });

    // Get uploads
    const uploads = await Upload.find({ userId: req.userId })
      .select('-filePath')
      .sort(sort)
      .skip(skip)
      .limit(limitNum)
      .lean();

    // Format response
    const formattedUploads = uploads.map((upload) => ({
      id: upload._id,
      fileName: upload.originalFileName,
      label: upload.predictedLabel,
      confidence: upload.confidence,
      status: upload.status,
      uploadedAt: upload.createdAt,
      ...(upload.error && { error: upload.error }),
    }));

    res.status(200).json({
      success: true,
      message: 'Upload history retrieved successfully',
      data: {
        uploads: formattedUploads,
        pagination: {
          currentPage: pageNum,
          totalPages: Math.ceil(totalCount / limitNum),
          totalCount,
          limit: limitNum,
        },
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Server Error',
    });
  }
};

// @desc    Get single upload details
// @route   GET /api/uploads/:id
// @access  Private
exports.getUpload = async (req, res) => {
  try {
    const upload = await Upload.findOne({
      _id: req.params.id,
      userId: req.userId,
    }).select('-filePath');

    if (!upload) {
      return res.status(404).json({
        success: false,
        message: 'Upload not found',
      });
    }

    res.status(200).json({
      success: true,
      data: {
        upload: {
          id: upload._id,
          fileName: upload.originalFileName,
          label: upload.predictedLabel,
          confidence: upload.confidence,
          status: upload.status,
          uploadedAt: upload.createdAt,
          ...(upload.error && { error: upload.error }),
        },
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Server Error',
    });
  }
};

// @desc    Delete upload record
// @route   DELETE /api/uploads/:id
// @access  Private
exports.deleteUpload = async (req, res) => {
  try {
    const upload = await Upload.findOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!upload) {
      return res.status(404).json({
        success: false,
        message: 'Upload not found',
      });
    }

    // Delete file if it exists
    if (upload.filePath) {
      await deleteFileSafely(upload.filePath);
    }

    // Delete from database
    await Upload.findByIdAndDelete(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Upload deleted successfully',
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Server Error',
    });
  }
};

// @desc    Download upload file
// @route   GET /api/uploads/:id/download
// @access  Private
exports.downloadUpload = async (req, res) => {
  try {
    const upload = await Upload.findOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!upload) {
      console.log(`[Download] Upload not found: ${req.params.id}`);
      return res.status(404).json({
        success: false,
        message: 'Upload not found',
      });
    }

    if (!upload.filePath) {
      console.log(`[Download] No filePath in database for upload ${req.params.id}`);
      return res.status(404).json({
        success: false,
        message: 'File path not set',
      });
    }

    if (!fs.existsSync(upload.filePath)) {
      console.log(`[Download] File does not exist at: ${upload.filePath}`);
      return res.status(404).json({
        success: false,
        message: 'File not found on server',
      });
    }

    console.log(`[Download] Serving file: ${upload.filePath}`);

    // Set appropriate headers for download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${upload.originalFileName}"`
    );

    // Send file
    const fileStream = fs.createReadStream(upload.filePath);
    fileStream.pipe(res);

    fileStream.on('error', (err) => {
      console.error('[Download] Error streaming file:', err);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Error downloading file',
        });
      }
    });
  } catch (error) {
    console.error('[Download] Unexpected error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Server Error',
    });
  }
};

// @desc    View upload file (inline)
// @route   GET /api/uploads/:id/view
// @access  Private
exports.viewUpload = async (req, res) => {
  try {
    const upload = await Upload.findOne({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!upload) {
      console.log(`[View] Upload not found: ${req.params.id}`);
      return res.status(404).json({
        success: false,
        message: 'Upload not found',
      });
    }

    if (!upload.filePath) {
      console.log(`[View] No filePath in database for upload ${req.params.id}`);
      return res.status(404).json({
        success: false,
        message: 'File path not set',
      });
    }

    if (!fs.existsSync(upload.filePath)) {
      console.log(`[View] File does not exist at: ${upload.filePath}`);
      return res.status(404).json({
        success: false,
        message: 'File not found on server',
      });
    }

    console.log(`[View] Serving file: ${upload.filePath}`);

    // Set appropriate headers for inline viewing
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${upload.originalFileName}"`);

    // Send file
    const fileStream = fs.createReadStream(upload.filePath);
    fileStream.pipe(res);

    fileStream.on('error', (err) => {
      console.error('[View] Error streaming file:', err);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Error viewing file',
        });
      }
    });
  } catch (error) {
    console.error('[View] Unexpected error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Server Error',
    });
  }
};
