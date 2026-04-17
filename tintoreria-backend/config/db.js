const mongoose = require("mongoose");

async function connectDB(
  uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/tintoreria_express"
) {
  mongoose.set("strictQuery", true);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
  });

  console.log(`MongoDB conectado: ${mongoose.connection.host}/${mongoose.connection.name}`);
  return mongoose.connection;
}

module.exports = connectDB;
