const nodemailer = require('nodemailer');

async function sendEmail({ subject, body }) {
    const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: {
            user: process.env.ALERT_EMAIL_USER,
            pass: process.env.ALERT_EMAIL_PASS
        }
    });

    const mailOptions = {
        from: `"BMW Alert Bot" <${process.env.ALERT_EMAIL_USER}>`,
        to: process.env.ALERT_EMAIL_TO,
        subject,
        text: body
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`📧 Email sent: ${subject}`);
    } catch (err) {
        console.error('❌ Email failed:', err);
    }
}

module.exports = { sendEmail };