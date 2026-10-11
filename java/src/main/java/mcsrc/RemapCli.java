package mcsrc;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * Command-line remapper that runs mcsrc's internal ASM + mapping-io remapping pipeline.
 */
public final class RemapCli {
    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("Usage: java mcsrc.RemapCli <input-client.jar> <mappings.txt> <output-remapped.jar>");
            System.exit(1);
        }

        Path inputJarPath = Paths.get(args[0]);
        Path mappingsPath = Paths.get(args[1]);
        Path outputJarPath = Paths.get(args[2]);

        long startTime = System.currentTimeMillis();

        System.out.println("[RemapCli] Reading mappings: " + mappingsPath);
        byte[] mappingsBytes = Files.readAllBytes(mappingsPath);

        System.out.println("[RemapCli] Reading and indexing input jar: " + inputJarPath);
        Indexer indexer = new Indexer();
        Map<String, byte[]> rawClasses = new HashMap<>();
        Map<String, byte[]> resources = new HashMap<>();

        try (ZipFile zipFile = new ZipFile(inputJarPath.toFile())) {
            Enumeration<? extends ZipEntry> entries = zipFile.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (entry.isDirectory()) continue;
                String name = entry.getName();

                try (InputStream is = zipFile.getInputStream(entry)) {
                    byte[] data = is.readAllBytes();
                    if (name.endsWith(".class")) {
                        rawClasses.put(name, data);
                        indexer.indexDeclarations(data);
                    } else {
                        resources.put(name, data);
                    }
                }
            }
        }

        System.out.println("[RemapCli] Indexed " + rawClasses.size() + " classes. Initializing ClassFileRemapper...");
        IndexData indexData = indexer.data();
        ClassFileRemapper remapper = new ClassFileRemapper(mappingsBytes, indexData);
        Map<String, String> classMappings = remapper.classMappings();

        if (outputJarPath.getParent() != null) {
            Files.createDirectories(outputJarPath.getParent());
        }

        System.out.println("[RemapCli] Remapping bytecode and writing to: " + outputJarPath);
        Set<String> writtenEntries = new HashSet<>();

        try (ZipOutputStream zos = new ZipOutputStream(new BufferedOutputStream(Files.newOutputStream(outputJarPath)))) {
            // Remap and write classes
            int count = 0;
            for (Map.Entry<String, byte[]> entry : rawClasses.entrySet()) {
                String oldPath = entry.getKey();
                byte[] classBytes = entry.getValue();

                byte[] remappedBytes = remapper.remap(classBytes);

                String oldClassName = oldPath.substring(0, oldPath.length() - ".class".length());
                String newClassName = classMappings.getOrDefault(oldClassName, oldClassName);
                String newPath = newClassName + ".class";

                if (writtenEntries.add(newPath)) {
                    ZipEntry zipEntry = new ZipEntry(newPath);
                    zos.putNextEntry(zipEntry);
                    zos.write(remappedBytes);
                    zos.closeEntry();
                }

                count++;
                if (count % 1000 == 0 || count == rawClasses.size()) {
                    System.out.printf("[RemapCli] Progress: %d / %d classes remapped%n", count, rawClasses.size());
                }
            }

            // Copy non-class resources (ignoring META-INF signatures that would conflict with modified bytecode)
            for (Map.Entry<String, byte[]> entry : resources.entrySet()) {
                String resName = entry.getKey();
                if (resName.startsWith("META-INF/") && (resName.endsWith(".SF") || resName.endsWith(".RSA") || resName.endsWith(".DSA"))) {
                    continue;
                }
                if (writtenEntries.add(resName)) {
                    ZipEntry zipEntry = new ZipEntry(resName);
                    zos.putNextEntry(zipEntry);
                    zos.write(entry.getValue());
                    zos.closeEntry();
                }
            }
        }

        long elapsed = System.currentTimeMillis() - startTime;
        System.out.printf("[RemapCli] Successfully remapped %d classes in %.2f seconds.%n", rawClasses.size(), elapsed / 1000.0);
    }
}
