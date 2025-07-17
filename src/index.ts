 import express, { Request, Response } from "express";
import cors from "cors";
import multer from "multer";
import admin from "firebase-admin";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY ?? '', 'base64').toString('utf8')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "elotitos-91a2f.firebasestorage.app",
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Initialize Twilio
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const app = express();
app.use(cors());
app.use(express.json());

/** INTERFACES **/
interface Material {
  uid: string;
  name: string;
  cost: number;
  quantity: number;
}

interface Topping {
  materialId: string;
  name: string;
  price: number;
  isActive: boolean;
}

interface SizeOption {
  name: string;
  price: number;
  quantity: number;
  materials: Material[];
  productionCost?: number;
  profit?: number;
}

interface StockHistory {
  totalStockBefore: number;
  date: string;
  addedStock: number;
  totalStockAfter: number;
  notes?: string;
  sizeName: string;
}

interface MaterialGroupEntry {
  materialId: string;
  priceMaterial: number;
  name: string;
}

interface Product {
  id?: string;
  name: string;
  description?: string;
  categoryId: string;
  sizes: SizeOption[];
  images: string[];
  materialsGroup?: MaterialGroupEntry[];
  toppings?: Topping[];
  stockHistory?: StockHistory[];
}

interface Category {
  id?: string;
  name: string;
  image: string;
  position?: number; // Optional, will be added dynamically
}

interface Customer {
  id?: string;
  phoneNumber: string;
  name: string;
  photo?: string;
  gender?: string;
  email?: string;
  address?: string;
  notes?: string;
  ordersCount: number;
}

interface OrderItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  subtotal: number;
  materials: Material[];
}

interface Order {
  items: OrderItem[];
  paymentMethod: string;
  total: number;
  productionCost: number;
  customerId?: string;
  date: Date;
}

/** ENDPOINTS **/

// GET /products
app.get("/products", async (req: Request, res: Response) => {
  try {
    const snapshot = await db.collection("inventory").get();
    const products = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    return res.json(products);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /products
app.post("/products", async (req: Request, res: Response) => {
  try {
    const { name, description, categoryId, sizes, images, materialsGroup, toppings } = req.body as Partial<Product> & {
      categoryId?: string;
      sizes?: SizeOption[];
      materialsGroup?: MaterialGroupEntry[];
      images?: string[];
      toppings?: Topping[];
    };

    if (!name) {
      return res.status(400).json({ error: "El nombre del producto es requerido." });
    }
    if (!categoryId) {
      return res.status(400).json({ error: "La categoría del producto es requerida." });
    }
    if (!sizes || sizes.length === 0) {
      return res.status(400).json({ error: "Debe agregar al menos una opción de tamaño." });
    }
    if (description && description.length > 500) {
      return res.status(400).json({ error: "La descripción no puede exceder los 500 caracteres." });
    }

    const materialCategoryId = "bsOZn7qdIizNleZ41Xs2";
    const toppingCategoryId = "NlMwnKfHw8PgUFDAFxlB";
    if (categoryId === materialCategoryId || categoryId === toppingCategoryId) {
      if (sizes.some((size) => size.materials.length > 0)) {
        return res.status(400).json({ error: "Los productos de la categoría Materiales o Toppings no pueden tener materiales asociados." });
      }
      if (toppings && toppings.length > 0) {
        return res.status(400).json({ error: "Los productos de la categoría Materiales o Toppings no pueden tener toppings asociados." });
      }
    }

    if (toppings) {
      for (const topping of toppings) {
        if (!topping.materialId || !topping.name || topping.price < 0 || typeof topping.isActive !== "boolean") {
          return res.status(400).json({ error: "Formato de topping inválido: debe incluir materialId, name, price y isActive." });
        }
      }
    }

    const processedSizes = sizes.map((size) => {
      const productionCost = size.materials.reduce(
        (sum, material) => sum + material.cost * (material.quantity > 0 ? material.quantity : 1),
        0
      );
      const profit = size.price - productionCost;
      return { ...size, productionCost, profit };
    });

    const newProduct: Product = {
      name,
      description: description || undefined,
      categoryId,
      sizes: processedSizes,
      images: images || [],
      materialsGroup: materialsGroup || [],
      toppings: toppings || [],
      stockHistory: [],
    };

    const docRef = await db.collection("inventory").add(newProduct);
    return res.json({ id: docRef.id, ...newProduct });
  } catch (error: any) {
    console.error("Error creating product:", error);
    return res.status(500).json({ error: "Error al crear el producto: " + error.message });
  }
});

// PUT /products/:id
app.put("/products/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, categoryId, sizes, images, materialsGroup, toppings } = req.body as Partial<Product> & {
      categoryId?: string;
      sizes?: SizeOption[];
      materialsGroup?: MaterialGroupEntry[];
      images?: string[];
      toppings?: Topping[];
    };

    if (!name) return res.status(400).json({ error: "El nombre del producto es requerido." });
    if (!categoryId) return res.status(400).json({ error: "La categoría del producto es requerida." });
    if (!sizes || sizes.length === 0) return res.status(400).json({ error: "Debe agregar al menos una opción de tamaño." });
    if (description && description.length > 500) {
      return res.status(400).json({ error: "La descripción no puede exceder los 500 caracteres." });
    }

    const materialCategoryId = "bsOZn7qdIizNleZ41Xs2";
    const toppingCategoryId = "NlMwnKfHw8PgUFDAFxlB";
    if (categoryId === materialCategoryId || categoryId === toppingCategoryId) {
      if (sizes.some((size) => size.materials.length > 0)) {
        return res.status(400).json({ error: "Los productos de la categoría Materiales o Toppings no pueden tener materiales asociados." });
      }
      if (toppings && toppings.length > 0) {
        return res.status(400).json({ error: "Los productos de la categoría Materiales o Toppings no pueden tener toppings asociados." });
      }
    }

    if (toppings) {
      for (const topping of toppings) {
        if (!topping.materialId || !topping.name || topping.price < 0 || typeof topping.isActive !== "boolean") {
          return res.status(400).json({ error: "Formato de topping inválido: debe incluir materialId, name, price y isActive." });
        }
      }
    }

    const processedSizes = sizes.map((size) => {
      const productionCost = size.materials.reduce(
        (sum, material) => sum + material.cost * (material.quantity > 0 ? material.quantity : 1),
        0
      );
      const profit = size.price - productionCost;
      return { ...size, productionCost, profit };
    });

    const productRef = db.collection("inventory").doc(id);
    const productSnapshot = await productRef.get();
    if (!productSnapshot.exists) {
      return res.status(404).json({ error: "Producto no encontrado." });
    }
    const existingProduct = productSnapshot.data() as Product;

    const updatedProduct: Product = {
      name,
      description: description || existingProduct.description || undefined,
      categoryId,
      sizes: processedSizes,
      images: images || existingProduct.images || [],
      materialsGroup: materialsGroup || existingProduct.materialsGroup || [],
      toppings: toppings || existingProduct.toppings || [],
      stockHistory: existingProduct.stockHistory || [],
    };

    await productRef.set(updatedProduct, { merge: true });
    return res.json({ id, ...updatedProduct });
  } catch (error: any) {
    console.error("Error updating product:", error);
    return res.status(500).json({ error: "Error al actualizar el producto: " + error.message });
  }
});

// POST /products/:id/upload
const upload = multer({ storage: multer.memoryStorage() });
app.post("/products/:id/upload", upload.array("images"), async (req: Request, res: Response) => {
  try {
    const productId = req.params.id;
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No se subieron archivos" });
    }

    const productRef = db.collection("inventory").doc(productId);
    const productSnapshot = await productRef.get();
    if (!productSnapshot.exists) {
      return res.status(404).json({ error: "Producto no encontrado." });
    }

    const imageUrls: string[] = [];
    for (const file of files) {
      const fileName = `${Date.now()}-${file.originalname}`;
      const fileUpload = bucket.file(`products/${productId}/${fileName}`);
      await fileUpload.save(file.buffer, { contentType: file.mimetype });
      await fileUpload.setMetadata({ metadata: { firebaseStorageDownloadTokens: fileName } });
      const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/products%2F${productId}%2F${encodeURIComponent(fileName)}?alt=media&token=${fileName}`;
      imageUrls.push(publicUrl);
    }

    await productRef.update({
      images: admin.firestore.FieldValue.arrayUnion(...imageUrls),
    });

    return res.json({ success: true, images: imageUrls });
  } catch (error: any) {
    console.error("Error uploading images:", error);
    return res.status(500).json({ error: "Error al subir imágenes: " + error.message });
  }
});

// PATCH /products/:id/stock
app.patch("/products/:id/stock", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const { sizeName, quantityDelta, notes } = req.body;
    if (!sizeName) {
      return res.status(400).json({ error: "Debe especificar el tamaño." });
    }
    const productRef = db.collection("inventory").doc(id);
    const snap = await productRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Producto no encontrado." });
    }
    const productData = snap.data() as Product;
    let sizeFound = false;
    const updatedSizes = productData.sizes.map((size) => {
      if (size.name === sizeName) {
        sizeFound = true;
        const newQuantity = size.quantity + quantityDelta;
        if (newQuantity < 0) {
          throw new Error(`Stock negativo no permitido para el tamaño ${sizeName}`);
        }
        const prodCost = size.materials.reduce((sum, m) => sum + m.cost * m.quantity, 0);
        const profit = size.price - prodCost;
        return { ...size, quantity: newQuantity, productionCost: prodCost, profit };
      }
      return size;
    });
    if (!sizeFound) {
      return res.status(404).json({ error: "Tamaño no encontrado en el producto." });
    }
    await productRef.update({ sizes: updatedSizes });
    const logEntry: StockHistory & { productId: string; productName: string; sizeName: string } = {
      date: new Date().toLocaleString(),
      addedStock: quantityDelta,
      totalStockBefore: productData.sizes.find((s) => s.name === sizeName)?.quantity ?? 0,
      totalStockAfter: updatedSizes.find((s) => s.name === sizeName)?.quantity ?? 0,
      notes: notes || "",
      productId: id,
      productName: productData.name,
      sizeName,
    };
    await db.collection("stockLogs").doc().set(logEntry);
    return res.json({ success: true, sizes: updatedSizes, log: logEntry });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /orders
app.get("/orders", async (req: Request, res: Response) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: "Se requieren parámetros 'start' y 'end'" });
    }

    const startDate = new Date(`${start}T00:00:00`);
    const endDate = new Date(`${end}T23:59:59`);

    const snapshot = await db
      .collection("orders")
      .where("date", ">=", startDate)
      .where("date", "<=", endDate)
      .get();

    const orders = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json(orders);
  } catch (error: any) {
    console.error("Error obteniendo órdenes:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /orders
app.post("/orders", async (req: Request, res: Response) => {
  try {
    const { items, paymentMethod, total, customerId } = req.body as Partial<Order>;

    if (!items || !paymentMethod || total === undefined) {
      return res.status(400).json({ error: "Faltan datos del pedido." });
    }

    const productionCost = items.reduce((totalCost, item) => {
      const itemCost = item.materials.reduce((sum, material) => {
        return sum + material.cost * (material.quantity > 0 ? material.quantity : 1) * item.quantity;
      }, 0);
      return totalCost + itemCost;
    }, 0);

    const orderData: Order = {
      items,
      paymentMethod,
      total,
      productionCost,
      customerId,
      date: new Date(),
    };

    const orderRef = db.collection("orders").doc();
    await db.runTransaction(async (transaction) => {
      const productUpdates: { ref: admin.firestore.DocumentReference; sizes: SizeOption[]; totalQuantity: number }[] = [];
      const materialUpdates: { ref: admin.firestore.DocumentReference; sizes: SizeOption[]; totalQuantity: number }[] = [];
      const stockLogs: { entry: StockHistory & { productId: string; productName: string; sizeName: string } }[] = [];

      let customerRef: admin.firestore.DocumentReference | null = null;
      if (customerId) {
        customerRef = db.collection("customers").doc(customerId);
        const customerSnap = await transaction.get(customerRef);
        if (!customerSnap.exists) {
          throw new Error(`Cliente no encontrado: ${customerId}`);
        }
      }

      for (const item of items) {
        const productRef = db.collection("inventory").doc(item.productId);
        const snap = await transaction.get(productRef);
        if (!snap.exists) {
          throw new Error(`Producto no encontrado: ${item.productId}`);
        }
        const product = snap.data() as Product;

        let sizeFound = false;
        const updatedSizes = product.sizes.map((size) => {
          if (size.name === item.name) {
            sizeFound = true;
            if (size.quantity < item.quantity) {
              throw new Error(`Stock insuficiente para ${item.name}`);
            }
            return { ...size, quantity: size.quantity - item.quantity };
          }
          return size;
        });
        if (!sizeFound) {
          throw new Error(`Tamaño no encontrado: ${item.name}`);
        }
        const newTotal = updatedSizes.reduce((sum, s) => sum + s.quantity, 0);
        productUpdates.push({ ref: productRef, sizes: updatedSizes, totalQuantity: newTotal });

        for (const material of item.materials) {
          const materialProductRef = db.collection("inventory").doc(material.uid);
          const materialSnap = await transaction.get(materialProductRef);
          if (!materialSnap.exists) {
            throw new Error(`Material no encontrado: ${material.uid}`);
          }
          const materialProduct = materialSnap.data() as Product;
          const materialSizes = materialProduct.sizes.map((size) => {
            const newQuantity = size.quantity - material.quantity * item.quantity;
            if (newQuantity < 0) {
              throw new Error(`Stock insuficiente para el material ${material.name}`);
            }
            return { ...size, quantity: newQuantity };
          });
          const materialTotal = materialSizes.reduce((sum, s) => sum + s.quantity, 0);
          materialUpdates.push({ ref: materialProductRef, sizes: materialSizes, totalQuantity: materialTotal });

          const materialLogEntry: StockHistory & { productId: string; productName: string; sizeName: string } = {
            date: new Date().toLocaleString(),
            addedStock: -(material.quantity * item.quantity),
            totalStockBefore: materialProduct.sizes[0]?.quantity ?? 0,
            totalStockAfter: materialSizes[0]?.quantity ?? 0,
            notes: `Deducción por orden ${orderRef.id}`,
            productId: material.uid,
            productName: material.name,
            sizeName: materialProduct.sizes[0]?.name || "Default",
          };
          stockLogs.push({ entry: materialLogEntry });
        }
      }

      transaction.set(orderRef, orderData);
      productUpdates.forEach(({ ref, sizes, totalQuantity }) => {
        transaction.update(ref, { sizes, totalQuantity });
      });
      materialUpdates.forEach(({ ref, sizes, totalQuantity }) => {
        transaction.update(ref, { sizes, totalQuantity });
      });
      stockLogs.forEach(({ entry }) => {
        transaction.set(db.collection("stockLogs").doc(), entry);
      });
      if (customerId && customerRef) {
        transaction.update(customerRef, {
          ordersCount: admin.firestore.FieldValue.increment(1),
        });
      }
    });

    printOrder(orderData, orderRef.id);

    return res.json({ success: true, orderId: orderRef.id });
  } catch (error: any) {
    console.error("Error al procesar el pedido:", error);
    return res.status(400).json({ error: error.message || "Error al procesar el pedido." });
  }
});

// DELETE /products/:id
app.delete("/products/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const productRef = db.collection("inventory").doc(id);
    const snap = await productRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "Producto no encontrado." });
    }
    await productRef.delete();
    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /categories
app.get("/categories", async (req: Request, res: Response) => {
  try {
    const snapshot = await db.collection("categories").get();
    const categories = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return res.json(categories);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /categories
app.post("/categories", upload.single("image"), async (req: Request, res: Response) => {
  try {
    const name = req.body.name;
    if (!name) {
      return res.status(400).json({ error: "Falta el nombre de la categoría." });
    }
    let imageUrl = "";
    if (req.file) {
      const fileName = `${Date.now()}-${req.file.originalname}`;
      const fileUpload = bucket.file(`categories/${fileName}`);
      await fileUpload.save(req.file.buffer, { contentType: req.file.mimetype });
      await fileUpload.setMetadata({ metadata: { firebaseStorageDownloadTokens: fileName } });
      imageUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/categories%2F${encodeURIComponent(fileName)}?alt=media&token=${fileName}`;
    }
    // Get the current number of categories to determine the new position
    const snapshot = await db.collection("categories").get();
    const newPosition = snapshot.size;
    const newCategory: Category = { name, image: imageUrl, position: newPosition };
    const docRef = await db.collection("categories").add(newCategory);
    return res.json({ id: docRef.id, ...newCategory });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// PATCH /categories/positions
app.patch("/categories/positions", async (req: Request, res: Response) => {
  try {
    const { categories } = req.body as { categories: { id: string; position: number }[] };
    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return res.status(400).json({ error: "Se requiere un array de categorías con id y position." });
    }

    // Validate input
    for (const cat of categories) {
      if (!cat.id || typeof cat.position !== "number") {
        return res.status(400).json({ error: "Cada categoría debe tener id y position válidos." });
      }
    }

    // Fetch all categories to ensure we update all positions
    const snapshot = await db.collection("categories").get();
    const existingCategories = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Category));

    // Update positions in a transaction
    await db.runTransaction(async (transaction) => {
      for (const cat of categories) {
        const categoryRef = db.collection("categories").doc(cat.id);
        const categorySnap = await transaction.get(categoryRef);
        if (!categorySnap.exists) {
          throw new Error(`Categoría no encontrada: ${cat.id}`);
        }
        const currentData = categorySnap.data() as Category;
        transaction.set(
          categoryRef,
          {
            ...currentData,
            position: cat.position,
          },
          { merge: true }
        );
      }
      // Ensure all categories have a position if they were missing it
      for (const existingCat of existingCategories) {
        if (!categories.find((c) => c.id === existingCat.id)) {
          const nextPosition = categories.length;
          const categoryRef = db.collection("categories").doc(existingCat.id ? existingCat.id : '');
          const currentData = existingCat;
          transaction.set(
            categoryRef,
            {
              ...currentData,
              position: nextPosition,
            },
            { merge: true }
          );
        }
      }
    });

    return res.json({ success: true });
  } catch (error: any) {
    console.error("Error updating category positions:", error);
    return res.status(500).json({ error: "Error al actualizar posiciones: " + error.message });
  }
});

// PATCH /categories/:id
app.patch("/categories/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: "El nombre de la categoría es requerido." });
    }
    const categoryRef = db.collection("categories").doc(id);
    const categorySnap = await categoryRef.get();
    if (!categorySnap.exists) {
      return res.status(404).json({ error: "Categoría no encontrada." });
    }
    await categoryRef.update({ name });
    return res.json({ success: true, id, name });
  } catch (error: any) {
    console.error("Error updating category name:", error);
    return res.status(500).json({ error: "Error al actualizar el nombre de la categoría: " + error.message });
  }
});

// DELETE /products/:id/images
app.delete("/products/:id/images", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const { imageUrl } = req.body;
    if (!imageUrl) {
      return res.status(400).json({ error: "No se proporcionó la URL de la imagen." });
    }

    const urlObj = new URL(imageUrl);
    const token = urlObj.searchParams.get("token");
    if (!token) {
      return res.status(400).json({ error: "No se pudo obtener el token de la imagen." });
    }

    const filePath = `products/${id}/${token}`;
    const file = bucket.file(filePath);
    await file.delete();

    await db.collection("inventory").doc(id).update({
      images: admin.firestore.FieldValue.arrayRemove(imageUrl),
    });

    return res.json({ success: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /customers
app.get("/customers", async (req: Request, res: Response) => {
  try {
    const snapshot = await db.collection("customers").get();
    const customers = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    return res.json(customers);
  } catch (error: any) {
    console.error("Error fetching customers:", error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /customers
app.post("/customers", async (req: Request, res: Response) => {
  try {
    const { uid, phoneNumber, name, photo, gender, email, address, notes, ordersCount } = req.body as Partial<Customer> & { uid: string };

    if (!uid) {
      return res.status(400).json({ error: "El UID de autenticación es requerido." });
    }
    if (!name) {
      return res.status(400).json({ error: "El nombre del cliente es requerido." });
    }
    if (!phoneNumber) {
      return res.status(400).json({ error: "El número telefónico es requerido." });
    }
    const phoneRegex = /^\d{10}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ error: "El número telefónico debe tener 10 dígitos." });
    }

    const [phoneSnapshot, uidSnapshot] = await Promise.all([
      db.collection("customers").where("phoneNumber", "==", phoneNumber).get(),
      db.collection("customers").doc(uid).get(),
    ]);
    if (!phoneSnapshot.empty) {
      return res.status(400).json({ error: "El número telefónico ya está registrado." });
    }
    if (uidSnapshot.exists) {
      return res.status(400).json({ error: "El UID ya está registrado." });
    }

    const newCustomer: Customer = {
      phoneNumber,
      name,
      photo: photo || "",
      gender: gender || "",
      email: email || "",
      address: address || "",
      notes: notes || "",
      ordersCount: ordersCount || 0,
    };

    await db.collection("customers").doc(uid).set(newCustomer);
    return res.json({ id: uid, ...newCustomer });
  } catch (error: any) {
    console.error("Error creating customer:", error);
    return res.status(500).json({ error: "Error al crear el cliente: " + error.message });
  }
});

// POST /send-otp
app.post("/send-otp", async (req: Request, res: Response) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json({ error: "El número telefónico es requerido." });
    }
    const phoneRegex = /^\+52\d{10}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ error: "El número telefónico debe tener el formato +52 seguido de 10 dígitos." });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const sessionId = Math.random().toString(36).substring(2);
    const verificationId = `verification-${sessionId}`;

    await twilioClient.messages.create({
      body: `Tu código de verificación para Elotitos es: ${otp}`,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${phoneNumber}`,
    });

    await db.collection("otps").doc(sessionId).set({
      otp,
      phoneNumber,
      verificationId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 5 * 60 * 1000)),
    });

    return res.json({ success: true, sessionId });
  } catch (error: any) {
    console.error("Error sending OTP:", error);
    return res.status(500).json({ error: "Error al enviar el código OTP: " + error.message });
  }
});

// POST /verify-otp
app.post("/verify-otp", async (req: Request, res: Response) => {
  try {
    const { sessionId, otp, phoneNumber } = req.body;
    if (!sessionId || !otp || !phoneNumber) {
      return res.status(400).json({ error: "Faltan datos: sessionId, otp o phoneNumber." });
    }

    const otpDoc = await db.collection("otps").doc(sessionId).get();
    if (!otpDoc.exists) {
      return res.status(400).json({ error: "Sesión OTP inválida o expirada." });
    }

    const otpData = otpDoc.data();
    if (!otpData) {
      return res.status(400).json({ error: "Datos OTP no encontrados." });
    }

    const { otp: storedOtp, phoneNumber: storedPhoneNumber, verificationId, expiresAt } = otpData;
    if (expiresAt.toDate() < new Date()) {
      await db.collection("otps").doc(sessionId).delete();
      return res.status(400).json({ error: "El código OTP ha expirado." });
    }

    if (otp !== storedOtp || phoneNumber !== storedPhoneNumber) {
      return res.status(400).json({ error: "Código OTP inválido." });
    }

    await db.collection("otps").doc(sessionId).delete();

    return res.json({ success: true, verificationId });
  } catch (error: any) {
    console.error("Error verifying OTP:", error);
    return res.status(500).json({ error: "Error al verificar el código OTP: " + error.message });
  }
});

// PRINT ORDER
const escpos = require("escpos");
escpos.Network = require("escpos-network");

const printOrder = (order: Order, orderId: string) => {
  const device = new escpos.Network("192.168.1.100", 9100);
  const printer = new escpos.Printer(device);

  device.open((err: any) => {
    if (err) {
      console.error("Error al conectar la impresora:", err);
      return;
    }

    printer
      .hardware("init")
      .raw("\x1B\x33\x00")
      .align("ct")
      .text("---------- ELOTITOS ----------")
      .text(`Orden #${orderId}`)
      .text("WhatsApp 2381046602")
      .text(`Fecha: ${order.date.toLocaleString()}`)
      .text("--------------------------")
      .align("lt")
      .text(`Método de pago: ${order.paymentMethod}`)
      .text(`Total: $${order.total.toFixed(2)}`)
      .text(`Costo de producción: $${order.productionCost.toFixed(2)}`)
      .text("--------------------------")
      .raw("\x1B\x33\x00")
      .text("Productos:");
    order.items.forEach((item) => {
      printer.text(`${item.name} x${item.quantity} - $${item.subtotal.toFixed(2)}`);
    });

    printer
      .text("--------------------------")
      .align("ct")
      .text("¡Gracias por su compra!")
      .text("                                ")
      .cut("partial")
      .close();
  });
};

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API escuchando en http://localhost:${PORT}`);
});
 