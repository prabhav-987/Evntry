const crypto = require('crypto');
const Booking = require('../models/Booking');
const Event = require('../models/Event');
const OTP = require('../models/OTP');
const { sendBookingEmail, sendOTPEmail } = require('../utils/email');
const { generateBookingQR } = require('../utils/qrcode');
const razorpay = require('../utils/razorpay');

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// Shared logic: marks a booking confirmed, deducts a seat, generates the
// ticket QR code, and emails the user. Used by both the payment-verification
// flow and the admin manual-confirm flow, and for auto-confirming free events.
const finalizeBooking = async (booking, event, paymentStatus) => {
    booking.status = 'confirmed';
    booking.paymentStatus = paymentStatus;

    const qrCode = await generateBookingQR(booking._id);
    booking.qrCode = qrCode;

    await booking.save();

    event.availableSeats -= 1;
    await event.save();

    await sendBookingEmail(booking.userId.email, booking.userId.name, event.title, qrCode);

    return booking;
};

exports.sendBookingOTP = async (req, res) => {
    try {
        const otp = generateOTP();
        await OTP.findOneAndDelete({ email: req.user.email, action: 'event_booking' });
        await OTP.create({ email: req.user.email, otp, action: 'event_booking' });
        await sendOTPEmail(req.user.email, otp, 'event_booking');
        res.json({ message: 'OTP sent successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error sending OTP', error: error.message });
    }
};

exports.bookEvent = async (req, res) => {
    try {
        const { eventId, otp } = req.body;

        const validOTP = await OTP.findOne({ email: req.user.email, otp, action: 'event_booking' });
        if (!validOTP) {
            return res.status(400).json({ message: 'Invalid or expired OTP for booking' });
        }

        const event = await Event.findById(eventId);
        if (!event) return res.status(404).json({ message: 'Event not found' });
        if (event.availableSeats <= 0) return res.status(400).json({ message: 'No seats available' });

        const existingBooking = await Booking.findOne({ userId: req.user.id, eventId });
        if (existingBooking && existingBooking.status !== 'cancelled') {
            return res.status(400).json({ message: 'Already booked or pending' });
        }

        let booking = await Booking.create({
            userId: req.user.id,
            eventId,
            status: 'pending',
            paymentStatus: 'not_paid',
            amount: event.ticketPrice
        });

        await OTP.deleteOne({ _id: validOTP._id });

        if (event.ticketPrice === 0) {
            booking = await Booking.findById(booking._id).populate('userId').populate('eventId');
            await finalizeBooking(booking, event, 'not_paid');
            return res.status(201).json({ message: 'Booking confirmed!', booking, requiresPayment: false });
        }

        res.status(201).json({ message: 'Booking created. Proceed to payment.', booking, requiresPayment: true });
    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.createOrder = async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id).populate('eventId');
        if (!booking) return res.status(404).json({ message: 'Booking not found' });
        if (booking.userId.toString() !== req.user.id) {
            return res.status(403).json({ message: 'Not authorized' });
        }
        if (booking.status === 'confirmed') {
            return res.status(400).json({ message: 'Booking already confirmed' });
        }

        const order = await razorpay.orders.create({
            amount: booking.amount * 100,
            currency: 'INR',
            receipt: `booking_${booking._id}`,
        });

        booking.razorpayOrderId = order.id;
        await booking.save();

        res.json({
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: process.env.RAZORPAY_KEY_ID,
            eventTitle: booking.eventId.title,
        });
    } catch (error) {
        res.status(500).json({ message: 'Error creating payment order', error: error.message });
    }
};

exports.verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        const booking = await Booking.findById(req.params.id).populate('userId').populate('eventId');
        if (!booking) return res.status(404).json({ message: 'Booking not found' });
        if (booking.razorpayOrderId !== razorpay_order_id) {
            return res.status(400).json({ message: 'Order mismatch' });
        }

        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ message: 'Payment verification failed' });
        }

        const event = await Event.findById(booking.eventId._id);
        if (event.availableSeats <= 0) {
            return res.status(400).json({ message: 'No seats available' });
        }

        booking.razorpayPaymentId = razorpay_payment_id;
        await finalizeBooking(booking, event, 'paid');

        res.json({ message: 'Payment verified, booking confirmed', booking });
    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.confirmBooking = async (req, res) => {
    try {
        const { paymentStatus } = req.body;
        const booking = await Booking.findById(req.params.id).populate('userId').populate('eventId');
        if (!booking) return res.status(404).json({ message: 'Booking not found' });

        if (booking.status === 'confirmed') return res.status(400).json({ message: 'Booking is already confirmed' });

        const event = await Event.findById(booking.eventId._id);
        if (event.availableSeats <= 0) {
            return res.status(400).json({ message: 'No seats available to confirm this booking' });
        }

        await finalizeBooking(booking, event, paymentStatus || booking.paymentStatus);

        res.json({ message: 'Booking confirmed successfully', booking });
    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.getMyBookings = async (req, res) => {
    try {
        const bookings = req.user.role === 'admin'
            ? await Booking.find().populate('eventId').populate('userId', 'name email').sort({ createdAt: -1 })
            : await Booking.find({ userId: req.user.id }).populate('eventId').sort({ createdAt: -1 });
        res.json(bookings);
    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

exports.cancelBooking = async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ message: 'Booking not found' });
        if (booking.userId.toString() !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ message: 'Not authorized' });
        }
        if (booking.status === 'cancelled') return res.status(400).json({ message: 'Already cancelled' });

        const wasConfirmed = booking.status === 'confirmed';

        booking.status = 'cancelled';
        await booking.save();

        if (wasConfirmed) {
            const event = await Event.findById(booking.eventId);
            if (event) {
                event.availableSeats += 1;
                await event.save();
            }
        }

        res.json({ message: 'Booking cancelled successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};
