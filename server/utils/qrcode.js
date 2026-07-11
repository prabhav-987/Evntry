const QRCode = require('qrcode');
const generateBookingQR = async (bookingId) => {
    try {
        const qrData = JSON.stringify({ bookingId: bookingId.toString() });
        const qrDataUrl = await QRCode.toDataURL(qrData, {
            width: 300,
            margin: 2,
        });
        return qrDataUrl;
    } catch (error) {
        console.error('Error generating QR code:', error);
        return null;
    }
};

module.exports = { generateBookingQR };